import type {
  ActOp,
  CdpSession,
  LookMode,
  Snapshot,
  SnapshotDelta,
  Store,
} from "./types";
import { compactAxTree, renderRefs, MAX_REFS, type AXNode } from "./snapshot";
import type { EvalCtx } from "./evaltool";
import { runEval } from "./evaltool";
import { applySkills } from "./skills";
import {
  hostAllowed,
  isConsequentialClick,
  type PendingAction,
} from "./guardrails";
import {
  frameScopes,
  nodeCall,
  scrollTarget,
  actionable,
  type NodeTarget,
} from "./frames";

/** The shared mutable closure state threaded through every tool. */
export interface BrowserContext {
  session: CdpSession;
  store: Store;
  defaultMode: LookMode;
  evalCtx: EvalCtx;
  lastRefs: Map<number, NodeTarget>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Navigation fence (#23). Empty = unrestricted. */
  allowDomains: string[];
  /** Consequential-action gate (#22). */
  dryRun: boolean;
  confirmAction?: (action: PendingAction) => Promise<boolean>;
  /** Set when a page-initiated navigation was bounced off the fence; reported on the next look. */
  blockedNav?: string;
}

// ── snapshot helpers ──────────────────────────────────────────────────────────

async function readUrlTitle(
  ctx: BrowserContext,
): Promise<{ url: string; title: string }> {
  const r = await runEval(
    ctx.evalCtx,
    "function(){return {url:location.href,title:document.title};}",
    [],
    {
      world: "main",
    },
  );
  if ("value" in r && r.value && typeof r.value === "object") {
    const v = r.value as { url?: string; title?: string };
    return { url: v.url ?? "", title: v.title ?? "" };
  }
  return { url: "", title: "" };
}

export interface LookOptions {
  mode?: LookMode;
  filter?: string;
  /** Skip this many matching refs before rendering. Pages through pages with >MAX_REFS elements. */
  offset?: number;
}

export async function look(
  ctx: BrowserContext,
  opts: LookOptions = {},
): Promise<{ snapshot: Snapshot; text: string }> {
  const mode = opts.mode ?? ctx.defaultMode;
  const { url, title } = await readUrlTitle(ctx);
  const { targetInfo } = await ctx.session.send<{
    targetInfo: { targetId: string };
  }>("Target.getTargetInfo", {});
  const targetId = targetInfo.targetId;

  if (mode === "screenshot") {
    const shot = await ctx.session.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" },
    );
    const snapshot: Snapshot = {
      targetId,
      url,
      title,
      refs: [],
      screenshot: shot.data,
      mode,
    };
    return {
      snapshot,
      text: `${title}\n${url}\n(screenshot fallback — ${shot.data.length} base64 bytes; use mode "a11y" to address elements)`,
    };
  }

  if (mode === "dom") {
    const r = await runEval(
      ctx.evalCtx,
      "function(){return document.body ? document.body.outerHTML.slice(0, 12000) : '';}",
      [],
      { world: "main" },
    );
    const html = "value" in r ? String(r.value ?? "") : "";
    const snapshot: Snapshot = { targetId, url, title, refs: [], mode };
    return { snapshot, text: `${title}\n${url}\n${html}` };
  }

  // a11y (default)
  const refs: Snapshot["refs"] = [];
  ctx.lastRefs.clear();
  for (const frame of await frameScopes(ctx.session)) {
    const tree = await frame.session.send<{ nodes: AXNode[] }>(
      "Accessibility.getFullAXTree",
      { frameId: frame.id },
    );
    const compact = compactAxTree(tree.nodes ?? []);
    for (const ref of compact.refs) {
      const id = refs.length + 1;
      refs.push({
        ...ref,
        ref: id,
        ...(frame.path ? { frame: frame.path } : {}),
      });
      ctx.lastRefs.set(id, { ...compact.refMap.get(ref.ref)!, frame });
    }
  }

  const snapshot: Snapshot = { targetId, url, title, refs, mode: "a11y" };

  // Filter runs over the whole page, then we window. The other order made anything
  // past MAX_REFS unreachable by any filter.
  let matched = refs;
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    matched = refs.filter(
      (r) =>
        r.role.toLowerCase().includes(f) || r.name.toLowerCase().includes(f),
    );
  }

  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const shown = matched.slice(offset, offset + MAX_REFS);
  const end = offset + shown.length;

  let header = opts.filter
    ? `${matched.length} of ${refs.length} refs match "${opts.filter}"`
    : `${refs.length} refs`;
  if (offset > 0 || end < matched.length) {
    header += ` — showing ${shown.length ? offset + 1 : 0}-${end}`;
    if (end < matched.length)
      header += `; look again with offset=${end} for the next ${MAX_REFS}`;
  }

  let note = "";
  if (ctx.blockedNav) {
    note = `\n(navigation to ${ctx.blockedNav} was blocked: outside the allowed domains ${ctx.allowDomains.join(", ")})`;
    ctx.blockedNav = undefined;
  }
  return {
    snapshot,
    text: `${title}\n${url}\n${header}${note}\n${renderRefs(shown)}`,
  };
}

function delta(snapshot: Snapshot, summary: string): SnapshotDelta {
  return {
    targetId: snapshot.targetId,
    url: snapshot.url,
    title: snapshot.title,
    summary,
    refs: snapshot.refs,
  };
}

// ── act ─────────────────────────────────────────────────────────────────────

const KEY_MAP: Record<string, { key: string; code: string; vk: number }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Space: { key: " ", code: "Space", vk: 32 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
};

async function clickAt(
  ctx: BrowserContext,
  x: number,
  y: number,
): Promise<void> {
  await ctx.session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await ctx.session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await ctx.session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function pressKey(ctx: BrowserContext, name: string): Promise<void> {
  const k = KEY_MAP[name] ?? { key: name, code: name, vk: 0 };
  const base = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
  };
  await ctx.session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
  });
  await ctx.session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function pause(ctx: BrowserContext, ms: number): Promise<void> {
  ctx.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      ctx.signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      reject(new Error("Action aborted"));
    };
    ctx.signal?.addEventListener("abort", abort, { once: true });
  });
}

async function readyTarget(
  ctx: BrowserContext,
  target: NodeTarget,
  editable = false,
): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + ctx.timeoutMs;
  let previous = "",
    reason = "not ready";
  while (Date.now() < deadline) {
    ctx.signal?.throwIfAborted();
    try {
      await scrollTarget(target);
      const state = await actionable(target, editable);
      const position = `${state.rect},${state.x},${state.y}`;
      if (position === previous) return state;
      previous = position;
      reason = "moving";
    } catch (e) {
      previous = "";
      reason = (e as Error).message;
    }
    await pause(ctx, 50);
  }
  throw new Error(
    `Timed out waiting for ${target.role} "${target.name}": ${reason}`,
  );
}

async function replaceText(
  ctx: BrowserContext,
  target: NodeTarget,
  value: string,
): Promise<void> {
  await readyTarget(ctx, target, true);
  await target.frame.session.send("DOM.focus", {
    backendNodeId: target.backendDOMNodeId,
  });
  await ctx.session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: process.platform === "darwin" ? 4 : 2,
    commands: ["selectAll"],
  });
  await ctx.session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: process.platform === "darwin" ? 4 : 2,
  });
  await pressKey(ctx, "Backspace");
  if (value) await ctx.session.send("Input.insertText", { text: value });
  const actual = await nodeCall<string>(
    target,
    "function(){return this.isContentEditable ? this.innerText : this.value;}",
  );
  if (actual !== value)
    throw new Error(
      `Fill verification failed for "${target.name}": value was not accepted`,
    );
}

/**
 * Wait for the DOM to quiesce: resolve once a MutationObserver sees no mutations
 * for `idleMs`, or `maxMs` elapses — whichever comes first. This captures animated
 * SPA transitions (slideshows, route changes) that never fire a load event, while
 * staying latency-bounded. Falls back to a short delay if the eval fails.
 */
async function waitForQuiet(
  ctx: BrowserContext,
  { idleMs = 250, maxMs = 1500 }: { idleMs?: number; maxMs?: number } = {},
): Promise<void> {
  const expression = `new Promise((resolve) => {
    let idle, max;
    const done = () => { clearTimeout(idle); clearTimeout(max); obs.disconnect(); resolve(true); };
    const obs = new MutationObserver(() => { clearTimeout(idle); idle = setTimeout(done, ${idleMs}); });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    idle = setTimeout(done, ${idleMs});
    max = setTimeout(done, ${maxMs});
  })`;
  try {
    await ctx.session.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
  } catch {
    await new Promise((r) => setTimeout(r, idleMs));
  }
}

export async function act(
  ctx: BrowserContext,
  ref: number,
  op: ActOp,
  value?: string,
): Promise<{ delta: SnapshotDelta; text: string }> {
  if (ctx.lastRefs.size === 0)
    throw new Error("No current refs; call look first");
  const target = ctx.lastRefs.get(ref);
  if (!target) {
    throw new Error(`ref ${ref} not found; call look to refresh the page`);
  }
  // The commit boundary (#22): a click that looks like submit/send/purchase is withheld
  // under dry-run, or requires explicit approval under --confirm. Everything before it
  // (navigate, read, fill) runs normally.
  if (
    isConsequentialClick(op, target.role, target.name) &&
    (ctx.dryRun || ctx.confirmAction)
  ) {
    const { url, title } = await readUrlTitle(ctx);
    const pending: PendingAction = {
      op,
      ref,
      role: target.role,
      name: target.name,
      value,
      url,
      title,
    };
    if (ctx.dryRun) {
      throw new Error(
        `DRY RUN: withheld ${op} on ${target.role} "${target.name}". Do not retry or seek another way to commit.`,
      );
    }
    const approved = await ctx.confirmAction!(pending);
    if (!approved) {
      throw new Error(
        `WITHHELD: ${op} on ${target.role} "${target.name}" was not approved. Do not retry or seek another way to commit.`,
      );
    }
  }

  const backendNodeId = target.backendDOMNodeId;
  switch (op) {
    case "click": {
      const { x, y } = await readyTarget(ctx, target);
      await clickAt(ctx, x, y);
      break;
    }
    case "type": {
      await readyTarget(ctx, target, true);
      await target.frame.session.send("DOM.focus", { backendNodeId });
      await ctx.session.send("Input.insertText", { text: value ?? "" });
      break;
    }
    case "press": {
      await readyTarget(ctx, target);
      await target.frame.session.send("DOM.focus", { backendNodeId });
      await pressKey(ctx, value ?? "Enter");
      break;
    }
    case "hover": {
      const { x, y } = await readyTarget(ctx, target);
      await ctx.session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      break;
    }
    case "select": {
      await readyTarget(ctx, target);
      await nodeCall(
        target,
        `function(v){
        if(!(this instanceof HTMLSelectElement))throw new Error('Target is not a select element');
        const option=Array.from(this.options).find(o=>o.value===v);
        if(!option || option.disabled)throw new Error('Option unavailable');
        this.value=v;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));
        if(this.value!==v)throw new Error('Selection was not accepted');
      }`,
        [value ?? ""],
      );
      break;
    }
    case "scroll": {
      const deltaY = value ? Number(value) : 600;
      const { x, y } = await readyTarget(ctx, target);
      await ctx.session.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY,
      });
      break;
    }
    default:
      throw new Error(`Unknown action: ${op}`);
  }

  await waitForQuiet(ctx);
  const fresh = await look(ctx);
  const note = `${op}${value != null ? ` "${value}"` : ""} on [${ref}] ${target.role} "${target.name}"`;
  return {
    delta: delta(fresh.snapshot, note),
    text: `${note}\n${fresh.text}`,
  };
}

export async function fill(
  ctx: BrowserContext,
  fields: { ref: number; value: string }[],
): Promise<{ delta: SnapshotDelta; text: string }> {
  if (ctx.lastRefs.size === 0)
    throw new Error("No current refs; call look first");
  for (const field of fields)
    if (!ctx.lastRefs.has(field.ref))
      throw new Error(`ref ${field.ref} not found; no fields were filled`);
  const done: string[] = [];
  for (const field of fields) {
    const target = ctx.lastRefs.get(field.ref)!;
    await replaceText(ctx, target, field.value);
    done.push(`[${field.ref}] "${field.value}"`);
  }
  await waitForQuiet(ctx);
  for (const field of fields) {
    const actual = await nodeCall<string>(
      ctx.lastRefs.get(field.ref)!,
      "function(){return this.isContentEditable ? this.innerText : this.value;}",
    );
    if (actual !== field.value)
      throw new Error(
        `Fill verification failed for ref ${field.ref}: value changed after input`,
      );
  }
  const fresh = await look(ctx);
  const note = `filled ${done.length} field(s): ${done.join(", ")}`;
  return { delta: delta(fresh.snapshot, note), text: `${note}\n${fresh.text}` };
}

// ── nav ───────────────────────────────────────────────────────────────────────

export type NavAction =
  | "goto"
  | "back"
  | "forward"
  | "reload"
  | "waitfor"
  | "newtab"
  | "switchtab";

interface NavHistory {
  currentIndex: number;
  entries: { id: number; url: string }[];
}

export async function nav(
  ctx: BrowserContext,
  action: NavAction,
  arg?: string,
): Promise<{
  result: SnapshotDelta | Snapshot;
  text: string;
  error?: boolean;
}> {
  // The navigation fence (#23): goto/newtab outside the allowlist are refused at the
  // tool layer, so staying on target is an invariant rather than a prompt-hope.
  if (
    (action === "goto" || action === "newtab") &&
    arg &&
    !hostAllowed(arg, ctx.allowDomains)
  ) {
    return {
      result: {
        url: "",
        title: "",
        summary: `blocked navigation to ${arg}`,
        refs: [],
      },
      text:
        `domain_not_allowed: ${arg} is outside the allowed domains (${ctx.allowDomains.join(", ")}). ` +
        `Navigation is restricted; if the task cannot proceed within these domains, stop and report BLOCKED.`,
      error: true,
    };
  }
  let committed = false;
  const offFrame = ctx.session.on("Page.frameNavigated", (p) => {
    if (!(p as { frame?: { parentId?: string } }).frame?.parentId)
      committed = true;
  });
  const offWithin = ctx.session.on("Page.navigatedWithinDocument", () => {
    committed = true;
  });
  const waitLoaded = async () => {
    const deadline = Date.now() + ctx.timeoutMs;
    while (Date.now() < deadline) {
      const r = await runEval(ctx.evalCtx, "() => document.readyState", [], {
        world: "main",
      });
      if (committed && "value" in r && r.value === "complete") return;
      await pause(ctx, 50);
    }
    throw new Error("Timed out waiting for navigation to complete");
  };
  try {
    switch (action) {
      case "goto": {
        ctx.lastRefs.clear();
        const response = await ctx.session.send<{ errorText?: string }>(
          "Page.navigate",
          { url: arg ?? "about:blank" },
        );
        if (response.errorText)
          throw new Error(`Navigation failed: ${response.errorText}`);
        ctx.evalCtx.isolatedContextId = undefined;
        await waitLoaded();
        const { url } = await readUrlTitle(ctx);
        await applySkills(ctx.session, ctx.store, url);
        break;
      }
      case "back":
      case "forward": {
        const hist = await ctx.session.send<NavHistory>(
          "Page.getNavigationHistory",
          {},
        );
        const entry =
          hist.entries[hist.currentIndex + (action === "back" ? -1 : 1)];
        if (!entry) throw new Error(`Cannot go ${action}: no history entry`);
        if (!hostAllowed(entry.url, ctx.allowDomains))
          throw new Error("History destination outside allowed domains");
        await ctx.session.send("Page.navigateToHistoryEntry", {
          entryId: entry.id,
        });
        await waitLoaded();
        break;
      }
      case "reload":
        await ctx.session.send("Page.reload", {});
        await waitLoaded();
        break;
      case "waitfor": {
        if (!arg) throw new Error("waitfor requires a selector or text");
        const deadline = Date.now() + ctx.timeoutMs;
        let found = false;
        while (Date.now() < deadline) {
          const r = await runEval(
            ctx.evalCtx,
            "function(sel){try{if(document.querySelector(sel))return true;}catch(e){}return (document.body?.innerText??'').includes(sel);}",
            [arg],
            { world: "main" },
          );
          if ("value" in r && r.value === true) {
            found = true;
            break;
          }
          await pause(ctx, 50);
        }
        if (!found) throw new Error(`Timed out waiting for "${arg}"`);
        break;
      }
      case "newtab": {
        if (!ctx.session.selectTarget)
          throw new Error(
            "Tab switching requires a browser-level CDP connection",
          );
        const { targetInfo } = await ctx.session.send<{
          targetInfo: { targetId: string };
        }>("Target.getTargetInfo", {});
        const created = await ctx.session.send<{ targetId: string }>(
          "Target.createTarget",
          { url: "about:blank" },
        );
        await ctx.session.selectTarget(created.targetId);
        const fresh = await nav(ctx, "goto", arg ?? "about:blank");
        return {
          ...fresh,
          result: { ...fresh.result, previousTargetId: targetInfo.targetId },
          text: `created new tab ${created.targetId}\n${fresh.text}`,
        };
      }
      case "switchtab": {
        if (!arg) throw new Error("switchtab requires a targetId");
        if (!ctx.session.selectTarget)
          throw new Error(
            "Tab switching requires a browser-level CDP connection",
          );
        const targets = await ctx.session.send<{
          targetInfos: { targetId: string; url: string; type: string }[];
        }>("Target.getTargets", {});
        const target = targets.targetInfos.find(
          (t) => t.targetId === arg && t.type === "page",
        );
        if (!target) throw new Error(`No tab with id "${arg}"`);
        if (!hostAllowed(target.url, ctx.allowDomains))
          throw new Error("Tab outside allowed domains");
        await ctx.session.selectTarget(arg);
        break;
      }
      default:
        throw new Error(`Unknown navigation action: ${action}`);
    }
    const snap = await look(ctx);
    return {
      result: snap.snapshot,
      text: `${action}${arg ? ` ${arg}` : ""}\n${snap.text}`,
    };
  } finally {
    offFrame();
    offWithin();
  }
}
