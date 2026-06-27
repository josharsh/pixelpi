// Programmatic API: a saved trace loads as a CALLABLE async function.
//
//   import { loadTrace } from "pixelpi";
//   const hn = loadTrace("hn");                 // by name (home library) or path
//   const r  = await hn({ query: "rust" });     // single  -> { ok, output, drift? }
//   const rs = await hn.over(rows, { concurrency: 4 }); // batch -> RowOutcome[]
//
// Strict by default (no model, no API key): replay the recorded actions with the row's values
// substituted. This is the "trace is the binary, and the binary takes arguments" surface.

import { MemoryStore } from "@josharsh/pixelpi-core";
import { DEFAULT_MODEL, ENV_VAR, type ResolvedSettings } from "./config";

const FALLBACK_MODEL = DEFAULT_MODEL.anthropic;
import { replayTrace as defaultReplay } from "./replay";
import { run as defaultRun, stringVars, type ReplayFn, type RowOutcome } from "./run";
import { substituteVars } from "./template";
import {
  describeTrace,
  loadTrace as readTraceFile,
  resolveTracePath,
  type Trace,
  type TraceDescription,
  type TraceParam,
} from "./trace";
import type { Reporter } from "./dashboard";

/** Result of calling a trace once. output is the last eval value (informational, never asserted). */
export interface RunOnceResult {
  ok: boolean;
  output?: unknown;
  drift?: { step: number; reason: string };
}

/** Per-call options. Strict replay needs nothing; pass headless/profile to control the browser. */
export interface CallOptions {
  headless?: boolean;
  profile?: string;
  signal?: AbortSignal;
}

/** Batch options for .over(). */
export interface OverOptions extends CallOptions {
  concurrency?: number;
  /** Stream outcomes to this JSONL path as they finish; omit to keep results in memory only. */
  outPath?: string;
  failFast?: boolean;
  timeoutMs?: number;
  /** Called as each row completes (live progress without a file). */
  onOutcome?: (outcome: RowOutcome) => void;
}

/** A loaded trace: call it with params to run once, or .over(rows) to map it across a dataset. */
export interface CallableTrace {
  (vars: Record<string, unknown>, opts?: CallOptions): Promise<RunOnceResult>;
  over(rows: Record<string, unknown>[], opts?: OverOptions): Promise<RowOutcome[]>;
  /** The trace's signature: name, task, params, output. Same object the `describe` command emits. */
  describe(): TraceDescription;
  readonly trace: Trace;
  readonly params: TraceParam[];
}

/** Injectable internals (the real ones launch Chrome); tests pass fakes. */
export interface LoadOptions extends CallOptions {
  replay?: ReplayFn;
  run?: typeof defaultRun;
}

/** A Reporter that just collects outcomes (and forwards them to an optional callback). */
function collectingReporter(into: RowOutcome[], onOutcome?: (o: RowOutcome) => void): Reporter {
  return {
    start() {},
    onRowStart() {},
    onRowStep() {},
    onRowDone(ev) {
      into.push(ev.outcome);
      onOutcome?.(ev.outcome);
    },
    done() {},
  };
}

/**
 * Load a trace by name (home library) or path and return it as a callable function.
 * Throws (via loadTrace) with a clear message if the trace is missing or invalid.
 */
export function loadTrace(nameOrPath: string, defaults: LoadOptions = {}): CallableTrace {
  const path = resolveTracePath(nameOrPath);
  const trace = readTraceFile(path);
  const replay = defaults.replay ?? (defaultReplay as ReplayFn);
  const runBatch = defaults.run ?? defaultRun;

  const settingsFor = (opts: CallOptions): ResolvedSettings => ({
    provider: "anthropic",
    model: trace.model || FALLBACK_MODEL,
    headless: opts.headless ?? defaults.headless ?? true,
    storePath: ".pixelpi-store.json",
    profileDir: opts.profile ?? defaults.profile,
    keySource: "none",
    envVar: ENV_VAR.anthropic,
  });

  const callable = (async (
    vars: Record<string, unknown>,
    opts: CallOptions = {},
  ): Promise<RunOnceResult> => {
    const substituted = substituteVars(trace, stringVars(vars));
    const result = await replay({
      trace: substituted,
      settings: settingsFor(opts),
      tracePath: path,
      store: new MemoryStore(),
      heal: false,
      signal: opts.signal ?? defaults.signal,
    });
    return { ok: result.ok, output: result.output, drift: result.drift };
  }) as CallableTrace;

  callable.over = async (
    rows: Record<string, unknown>[],
    opts: OverOptions = {},
  ): Promise<RowOutcome[]> => {
    const collected: RowOutcome[] = [];
    await runBatch({
      trace,
      tracePath: path,
      settings: settingsFor(opts),
      rows,
      reporter: collectingReporter(collected, opts.onOutcome),
      concurrency: opts.concurrency ?? 4,
      outPath: opts.outPath,
      heal: false,
      failFast: opts.failFast ?? false,
      timeoutMs: opts.timeoutMs ?? 60000,
      resume: false,
      yes: true,
      replay,
      signal: opts.signal ?? defaults.signal,
    });
    // Return aligned to input order (a map), even though rows finish out of order under concurrency.
    // The onOutcome callback already fired in completion order for live progress.
    return collected.sort((a, b) => a.index - b.index);
  };

  callable.describe = () => describeTrace(trace, nameOrPath);

  Object.defineProperty(callable, "trace", { value: trace, enumerable: true });
  Object.defineProperty(callable, "params", { value: trace.params ?? [], enumerable: true });
  return callable;
}
