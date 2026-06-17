import type { CdpSession } from "./types";

/** Shared eval/runtime context: the session plus a cached isolated world per frame. */
export interface EvalCtx {
  session: CdpSession;
  /** Main frame id, resolved lazily. */
  frameId(): Promise<string>;
  /** Cached isolated-world executionContextId, created on first use. */
  isolatedContextId?: number;
  /** Object handles returned to the agent with handle:true (kept for later release). */
  handles: Set<string>;
}

interface ExceptionDetails {
  exception?: { description?: string };
  text?: string;
}
interface RemoteObject {
  objectId?: string;
  value?: unknown;
}
interface CallResult {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

function exceptionText(d: ExceptionDetails): string {
  return d.exception?.description ?? d.text ?? "eval error";
}

async function isolatedContext(ctx: EvalCtx): Promise<number> {
  if (ctx.isolatedContextId != null) return ctx.isolatedContextId;
  const frameId = await ctx.frameId();
  const res = await ctx.session.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
    frameId,
    worldName: "pixelpi",
  });
  ctx.isolatedContextId = res.executionContextId;
  return res.executionContextId;
}

/** Resolve a `globalThis` objectId in the target world to call functions on. */
async function globalObjectId(ctx: EvalCtx, world: "main" | "isolated"): Promise<string> {
  const params: Record<string, unknown> = { expression: "globalThis", returnByValue: false };
  if (world === "isolated") params.contextId = await isolatedContext(ctx);
  const res = await ctx.session.send<{ result: RemoteObject }>("Runtime.evaluate", params);
  if (!res.result.objectId) throw new Error("could not resolve globalThis");
  return res.result.objectId;
}

export interface EvalOptions {
  world?: "main" | "isolated";
  handle?: boolean;
  host?: boolean;
}

export type EvalReturn = { value: unknown } | { handle: string } | { error: string };

/**
 * Normalize `fn` into a callable function expression. If it already looks like a
 * function expression (arrow, `function`, or identifier-arrow) it's returned
 * unchanged; otherwise it's treated as a bare statement body and wrapped as an
 * async arrow so it can use `args`, `await`, and `return`.
 */
export function wrapFn(fn: string): string {
  const t = fn.trim();
  if (/^(async\s+)?(\(|function\b)/.test(t)) return fn;
  if (/^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(t)) return fn;
  return `(async (...args) => { ${fn} })`;
}

/**
 * Run `fn` (a function expression OR a bare statement body string) with `args`
 * passed ONLY through the arguments array (never string-interpolated). A bare
 * body may use `args`, `await`, and `return`. Returns a value, an object handle,
 * or an error. host:true runs fn in Node with a CORS-free fetch.
 */
export async function runEval(
  ctx: EvalCtx,
  fn: string,
  args: unknown[] = [],
  opts: EvalOptions = {},
): Promise<EvalReturn> {
  if (opts.host) {
    try {
      const hostFn = new Function("fetch", "args", `return (${wrapFn(fn)}).apply(null, args);`);
      const value = await hostFn(fetch, args);
      return { value };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  const world = opts.world ?? "isolated";
  try {
    const objectId = await globalObjectId(ctx, world);
    const res = await ctx.session.send<CallResult>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: wrapFn(fn),
      arguments: args.map((value) => ({ value })),
      returnByValue: !opts.handle,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) return { error: exceptionText(res.exceptionDetails) };
    if (opts.handle) {
      const id = res.result.objectId;
      if (!id) return { value: res.result.value };
      ctx.handles.add(id);
      return { handle: id };
    }
    return { value: res.result.value };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
