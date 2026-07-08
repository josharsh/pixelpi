import type { ActOp, CdpSession, LookMode, Snapshot, SnapshotDelta, Store } from "./types";
import { compactAxTree, renderRefs, type AXNode } from "./snapshot";
import type { EvalCtx } from "./evaltool";
import { runEval } from "./evaltool";
import { applySkills } from "./skills";

/** The shared mutable closure state threaded through every tool. */
export interface BrowserContext {
  session: CdpSession;
  store: Store;
  defaultMode: LookMode;
  evalCtx: EvalCtx;
  lastRefs: Map<number, { backendDOMNodeId: number; role: string; name: string }>;
}

interface BoxModel {
  model: { content: number[] };
}

// ── snapshot helpers ──────────────────────────────────────────────────────────

async function readUrlTitle(ctx: BrowserContext): Promise<{ url: string; title: string }> {
  const r = await runEval(ctx.evalCtx, "function(){return {url:location.href,title:document.title};}", [], {
    world: "main",
  });
  if ("value" in r && r.value && typeof r.value === "object") {
    const v = r.value as { url?: string; title?: string };
    return { url: v.url ?? "", title: v.title ?? "" };
  }
  return { url: "", title: "" };
}

export interface LookOptions {
  mode?: LookMode;
  filter?: string;
}

export async function look(ctx: BrowserContext, opts: LookOptions = {}): Promise<{ snapshot: Snapshot; text: string }> {
  const mode = opts.mode ?? ctx.defaultMode;
  const { url, title } = await readUrlTitle(ctx);

  if (mode === "screenshot") {
    const shot = await ctx.session.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    const snapshot: Snapshot = { url, title, refs: [], screenshot: shot.data, mode };
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
    const snapshot: Snapshot = { url, title, refs: [], mode };
    return { snapshot, text: `${title}\n${url}\n${html}` };
  }

  // a11y (default)
  const tree = await ctx.session.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {});
  const { refs, refMap, truncated, truncatedCount } = compactAxTree(tree.nodes ?? []);

  ctx.lastRefs.clear();
  for (const [k, v] of refMap) ctx.lastRefs.set(k, v);

  const snapshot: Snapshot = { url, title, refs, mode: "a11y" };
  let filtered = refs;
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    filtered = refs.filter((r) => r.role.toLowerCase().includes(f) || r.name.toLowerCase().includes(f));
  }
  const header = `${title}\n${url}\n${filtered.length} of ${refs.length} refs${truncated ? " (TRUNCATED at 200)" : ""}`;
  let text = `${header}\n${renderRefs(filtered)}`;
  if (truncated && truncatedCount > 0) {
    text += `\n… ${truncatedCount} more elements below — scroll or filter`;
  }
  return { snapshot, text };
}

function delta(snapshot: Snapshot, summary: string): SnapshotDelta {
  return { url: snapshot.url, title: snapshot.title, summary, refs: snapshot.refs };
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

async function centerOf(ctx: BrowserContext, backendNodeId: number): Promise<{ x: number; y: number }> {
  const box = await ctx.session.send<BoxModel>("DOM.getBoxModel", { backendNodeId });
  const q = box.model.content;
  const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
  const y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
  return { x, y };
}

async function clickAt(ctx: BrowserContext, x: number, y: number): Promise<void> {
  await ctx.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
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
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await ctx.session.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await ctx.session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function selectValue(ctx: BrowserContext, backendNodeId: number, value: string): Promise<void> {
  const resolved = await ctx.session.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId });
  await ctx.session.send("Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: "function(v){this.value=v;this.dispatchEvent(new Event('change',{bubbles:true}));}",
    arguments: [{ value }],
    awaitPromise: true,
  });
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
  if (ctx.lastRefs.size === 0) await look(ctx);
  const target = ctx.lastRefs.get(ref);
  if (!target) {
    const snap = await look(ctx);
    return {
      delta: delta(snap.snapshot, `ref ${ref} not found; refreshed snapshot`),
      text: `ref ${ref} not found. Fresh snapshot:\n${snap.text}`,
    };
  }
  const backendNodeId = target.backendDOMNodeId;
  await ctx.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);

  switch (op) {
    case "click": {
      const { x, y } = await centerOf(ctx, backendNodeId);
      await clickAt(ctx, x, y);
      break;
    }
    case "type": {
      await ctx.session.send("DOM.focus", { backendNodeId });
      await ctx.session.send("Input.insertText", { text: value ?? "" });
      break;
    }
    case "press": {
      await pressKey(ctx, value ?? "Enter");
      break;
    }
    case "hover": {
      const { x, y } = await centerOf(ctx, backendNodeId);
      await ctx.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      break;
    }
    case "select": {
      await selectValue(ctx, backendNodeId, value ?? "");
      break;
    }
    case "scroll": {
      const deltaY = value ? Number(value) : 600;
      const { x, y } = await centerOf(ctx, backendNodeId).catch(() => ({ x: 10, y: 10 }));
      await ctx.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
      break;
    }
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
  if (ctx.lastRefs.size === 0) await look(ctx);
  const done: string[] = [];
  for (const field of fields) {
    const target = ctx.lastRefs.get(field.ref);
    if (!target) {
      done.push(`[${field.ref}] not found`);
      continue;
    }
    await ctx.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendDOMNodeId }).catch(() => undefined);
    await ctx.session.send("DOM.focus", { backendNodeId: target.backendDOMNodeId });
    await ctx.session.send("Input.insertText", { text: field.value });
    done.push(`[${field.ref}] "${field.value}"`);
  }
  await waitForQuiet(ctx);
  const fresh = await look(ctx);
  const note = `filled ${done.length} field(s): ${done.join(", ")}`;
  return { delta: delta(fresh.snapshot, note), text: `${note}\n${fresh.text}` };
}

// ── nav ───────────────────────────────────────────────────────────────────────

export type NavAction = "goto" | "back" | "forward" | "reload" | "waitfor" | "newtab" | "switchtab";

interface NavHistory {
  currentIndex: number;
  entries: { id: number; url: string }[];
}

export async function nav(
  ctx: BrowserContext,
  action: NavAction,
  arg?: string,
): Promise<{ result: SnapshotDelta | Snapshot; text: string }> {
  switch (action) {
    case "goto": {
      const loaded = ctx.session.once("Page.loadEventFired", { timeoutMs: 15000 }).catch(() => undefined);
      await ctx.session.send("Page.navigate", { url: arg ?? "about:blank" });
      await loaded;
      ctx.evalCtx.isolatedContextId = undefined;
      const { url } = await readUrlTitle(ctx);
      const applied = await applySkills(ctx.session, ctx.store, url);
      const snap = await look(ctx);
      const skillNote = applied.length ? `\n(applied skills: ${applied.join(", ")})` : "";
      return { result: snap.snapshot, text: `navigated to ${arg}${skillNote}\n${snap.text}` };
    }
    case "back":
    case "forward": {
      const hist = await ctx.session.send<NavHistory>("Page.getNavigationHistory", {});
      const idx = action === "back" ? hist.currentIndex - 1 : hist.currentIndex + 1;
      const entry = hist.entries[idx];
      if (!entry) return { result: (await look(ctx)).snapshot, text: `cannot go ${action}: no entry` };
      const loaded = ctx.session.once("Page.loadEventFired", { timeoutMs: 15000 }).catch(() => undefined);
      await ctx.session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      await loaded;
      ctx.evalCtx.isolatedContextId = undefined;
      const snap = await look(ctx);
      return { result: snap.snapshot, text: `went ${action}\n${snap.text}` };
    }
    case "reload": {
      const loaded = ctx.session.once("Page.loadEventFired", { timeoutMs: 15000 }).catch(() => undefined);
      await ctx.session.send("Page.reload", {});
      await loaded;
      ctx.evalCtx.isolatedContextId = undefined;
      const snap = await look(ctx);
      return { result: snap.snapshot, text: `reloaded\n${snap.text}` };
    }
    case "waitfor": {
      const needle = arg ?? "";
      const deadline = Date.now() + 15000;
      let found = false;
      while (Date.now() < deadline) {
        const r = await runEval(
          ctx.evalCtx,
          "function(sel){try{if(document.querySelector(sel))return true;}catch(e){}return (document.body?document.body.innerText:'').includes(sel);}",
          [needle],
          { world: "main" },
        );
        if ("value" in r && r.value === true) {
          found = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      const snap = await look(ctx);
      return {
        result: delta(snap.snapshot, found ? `found "${needle}"` : `timed out waiting for "${needle}"`),
        text: `${found ? "found" : "timed out waiting for"} "${needle}"\n${snap.text}`,
      };
    }
    case "newtab": {
      const created = await ctx.session.send<{ targetId: string }>("Target.createTarget", {
        url: arg ?? "about:blank",
      });
      const snap = await look(ctx);
      return {
        result: delta(snap.snapshot, `created tab ${created.targetId} (this session stays on the original tab)`),
        text: `created new tab ${created.targetId}. Note: this session remains attached to the original tab; reconnect to drive the new one.`,
      };
    }
    case "switchtab": {
      await ctx.session.send("Target.activateTarget", { targetId: arg });
      const snap = await look(ctx);
      return {
        result: delta(snap.snapshot, `activated tab ${arg} (session still drives the original tab)`),
        text: `activated tab ${arg}. Note: single-client session still drives the original tab.`,
      };
    }
  }
}
