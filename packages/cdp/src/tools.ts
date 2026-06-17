import type {
  ActOp,
  BrowserToolsOptions,
  CdpSession,
  CreateBrowserTools,
  LookMode,
  Skill,
  Tool,
} from "./types";
import type { BrowserContext, NavAction } from "./actions";
import { act, fill, look, nav } from "./actions";
import { runEval, type EvalCtx } from "./evaltool";
import { applySkills, skillMatches, wrapSkill } from "./skills";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function resolveMainFrameId(session: CdpSession): Promise<string> {
  const tree = await session.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {});
  return tree.frameTree.frame.id;
}

export const createBrowserTools: CreateBrowserTools = (opts: BrowserToolsOptions): Tool[] => {
  const session = opts.session;
  const store = opts.store;
  const defaultMode: LookMode = opts.defaultMode ?? "a11y";

  let mainFrameId: string | undefined;
  const evalCtx: EvalCtx = {
    session,
    handles: new Set<string>(),
    async frameId() {
      if (!mainFrameId) mainFrameId = await resolveMainFrameId(session);
      return mainFrameId;
    },
  };

  const ctx: BrowserContext = {
    session,
    store,
    defaultMode,
    evalCtx,
    lastRefs: new Map(),
  };

  // Skills registered via addScriptToEvaluateOnNewDocument (idempotent by name).
  const registered = new Set<string>();

  // Init: enable the domains we rely on. Fire-and-forget — failures surface on first use.
  void (async () => {
    await session.send("Page.enable", {}).catch(() => undefined);
    await session.send("DOM.enable", {}).catch(() => undefined);
    await session.send("Runtime.enable", {}).catch(() => undefined);
    await session.send("Accessibility.enable", {}).catch(() => undefined);
  })();

  // Re-apply matching skills + invalidate the cached isolated world on main-frame nav.
  session.on("Page.frameNavigated", (params) => {
    const frame = (params as { frame?: { parentId?: string; url?: string } }).frame;
    if (!frame || frame.parentId) return; // main frame only
    evalCtx.isolatedContextId = undefined;
    if (frame.url) void applySkills(session, store, frame.url).catch(() => undefined);
  });

  const lookTool: Tool = {
    name: "look",
    description:
      "Observe the page as a compact, ref-indexed accessibility tree. Returns addressable [ref] elements you pass to act/fill. mode: a11y (default), dom, or screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a11y", "dom", "screenshot"] },
        filter: { type: "string", description: "Case-insensitive substring filter on role/name." },
      },
    },
    async execute(input) {
      const { snapshot, text } = await look(ctx, {
        mode: str(input.mode) as LookMode | undefined,
        filter: str(input.filter),
      });
      return { content: text, observation: snapshot };
    },
  };

  const actTool: Tool = {
    name: "act",
    description:
      "Interact with one element by its [ref] from the latest look. op: click | type | select | hover | press | scroll. value is the text to type, key name to press, option to select, or scroll deltaY.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "number" },
        op: { type: "string", enum: ["click", "type", "select", "hover", "press", "scroll"] },
        value: { type: "string" },
      },
      required: ["ref", "op"],
    },
    async execute(input) {
      const { delta, text } = await act(ctx, Number(input.ref), input.op as ActOp, str(input.value));
      return { content: text, observation: delta };
    },
  };

  const fillTool: Tool = {
    name: "fill",
    description:
      "Fill multiple fields in one shot. fields: [{ ref, value }]. Focuses and types each in order, then returns one snapshot delta.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: { ref: { type: "number" }, value: { type: "string" } },
            required: ["ref", "value"],
          },
        },
      },
      required: ["fields"],
    },
    async execute(input) {
      const fields = (input.fields as { ref: number; value: string }[]) ?? [];
      const { delta, text } = await fill(ctx, fields);
      return { content: text, observation: delta };
    },
  };

  const navTool: Tool = {
    name: "nav",
    description:
      "Navigate or wait. action: goto (arg=url) | back | forward | reload | waitfor (arg=selector or text) | newtab (arg=url) | switchtab (arg=targetId).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["goto", "back", "forward", "reload", "waitfor", "newtab", "switchtab"],
        },
        arg: { type: "string" },
      },
      required: ["action"],
    },
    async execute(input) {
      const { result, text } = await nav(ctx, input.action as NavAction, str(input.arg));
      return { content: text, observation: result };
    },
  };

  const evalTool: Tool = {
    name: "eval",
    description:
      "The universal escape hatch. Run JS in the page. fn may be a function expression like () => {...} OR a bare statement body like `return document.title` (it can use args, await, and return). Pass data ONLY via the args array — never string-interpolate it into fn. Use eval for BULK DATA extraction (read text/attributes/JSON in one call), NOT for faking clicks/keystrokes: synthetic events are untrusted; use act/fill for real input. opts.world 'isolated' (default) or 'main'; opts.handle returns an object handle instead of a value; opts.host runs fn in Node with a CORS-free fetch for cross-origin requests.",
    inputSchema: {
      type: "object",
      properties: {
        fn: { type: "string" },
        args: { type: "array" },
        opts: {
          type: "object",
          properties: {
            world: { type: "string", enum: ["main", "isolated"] },
            handle: { type: "boolean" },
            host: { type: "boolean" },
          },
        },
      },
      required: ["fn"],
    },
    async execute(input) {
      const fn = str(input.fn) ?? "function(){}";
      const args = Array.isArray(input.args) ? (input.args as unknown[]) : [];
      const o = (input.opts as { world?: "main" | "isolated"; handle?: boolean; host?: boolean }) ?? {};
      const res = await runEval(ctx.evalCtx, fn, args, o);
      if ("error" in res) return { content: res.error, isError: true, observation: res };
      if ("handle" in res) return { content: `handle:${res.handle}`, observation: res };
      let json: string;
      try {
        json = JSON.stringify(res.value) ?? "undefined";
      } catch {
        json = String(res.value);
      }
      if (json.length > 8000) json = json.slice(0, 8000) + "…(truncated)";
      return { content: json, observation: res };
    },
  };

  async function registerSkill(skill: Skill): Promise<void> {
    const wrapped = wrapSkill(skill);
    if (!registered.has(skill.name)) {
      await session.send("Page.addScriptToEvaluateOnNewDocument", { source: wrapped });
      registered.add(skill.name);
    }
    // Apply immediately if it matches the current page.
    const cur = await runEval(ctx.evalCtx, "function(){return location.href;}", [], { world: "main" });
    const url = "value" in cur ? String(cur.value ?? "") : "";
    if (url && skillMatches(skill, url)) {
      await session.send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, userGesture: true });
    }
  }

  const storeTool: Tool = {
    name: "store",
    description:
      "The browser's durable filesystem (JSON-valued). action: get | set | delete | list. Keys under 'skills/<name>' register a Skill (auto-injected on matching pages and persisted across navigations).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "delete", "list"] },
        key: { type: "string" },
        value: {},
      },
      required: ["action"],
    },
    async execute(input) {
      const action = str(input.action);
      const key = str(input.key);
      switch (action) {
        case "get": {
          const v = await store.get(key ?? "");
          return { content: JSON.stringify(v) ?? "null", observation: v };
        }
        case "set": {
          await store.set(key ?? "", input.value);
          if (key && key.startsWith("skills/") && input.value && typeof input.value === "object") {
            const skill = input.value as Skill;
            await registerSkill(skill).catch(() => undefined);
            return { content: `set ${key} and registered skill "${skill.name}"` };
          }
          return { content: `set ${key}` };
        }
        case "delete": {
          await store.delete(key ?? "");
          return { content: `deleted ${key}` };
        }
        case "list": {
          const keys = await store.list(key);
          return { content: keys.join("\n") || "(empty)", observation: keys };
        }
        default:
          return { content: `unknown store action: ${action}`, isError: true };
      }
    },
  };

  return [lookTool, actTool, fillTool, navTool, evalTool, storeTool];
};
