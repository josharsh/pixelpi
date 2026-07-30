// `pixelpi run`: turn a parametrized trace into a function and map it over a dataset, in parallel,
// with zero-token replay and self-healing on the warm-up row. Mental model:
//   trace = function(params) -> result ; run = map(function, rows).
//
// Orchestration (see EXECUTION MODEL): load data, validate required params BEFORE any browser,
// run row 0 ALONE (heal-once writeback to the shared trace, ETA seed), optionally prompt, then
// fan out rows 1..N-1 on a bounded worker pool with per-row isolation (clone + substitute, fresh
// MemoryStore, disposable-or-copied profile), streaming each outcome to the out JSONL.
//
// Fan-out rows replay strictly. When one drifts under --heal, ONE worker takes a heal lock, repairs
// that row with the model, grafts the repair onto the shared template, and every other worker that
// drifted meanwhile retries against the repaired template instead of failing. Bounded by maxHeals,
// so a genuinely broken site costs a handful of model runs, not one per row.
//
// replayTrace and the profile copy are injected so this is testable without Chrome or the network.

import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "@josharsh/pixelpi-core";
import type { Store } from "@josharsh/pixelpi-core";
import type { ResolvedSettings } from "./config";
import { replayTrace as defaultReplayTrace, type ReplayResult, type ReplayStep } from "./replay";
import { substituteVars, validateParams } from "./template";
import { saveTrace, type Trace, type TraceStep } from "./trace";
import type { Reporter } from "./dashboard";

/**
 * Default mid-run repair budget. A site that changed once needs one repair; a site that keeps
 * drifting is broken, and burning a model run per row would cost more than the batch is worth.
 */
export const DEFAULT_MAX_HEALS = 3;

// ── public result types ───────────────────────────────────────────────────────

/** One row's machine-readable outcome. Streamed as one JSON line to the out file. */
export interface RowOutcome {
  index: number;
  input: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  drift?: { step: number; reason: string };
  error?: string;
  ms: number;
}

/** The aggregate result of a whole batch. */
export interface RunSummary {
  total: number;
  ran: number;
  skipped: number;
  ok: number;
  drift: number;
  error: number;
  /** Mid-run model repairs spent during the fan-out (excludes the warm-up row's own healing). */
  healed: number;
  ms: number;
  aborted: boolean;
  /** Where row outcomes were streamed. */
  outPath: string;
}

/** Injectable replay function (the real one launches Chrome; tests pass a fake). */
export type ReplayFn = (opts: {
  trace: Trace;
  settings: ResolvedSettings;
  tracePath: string;
  store?: Store;
  heal: boolean;
  signal?: AbortSignal;
  onStep?: (step: ReplayStep) => void;
}) => Promise<ReplayResult>;

export interface RunOptions {
  trace: Trace;
  tracePath: string;
  settings: ResolvedSettings;
  rows: Record<string, unknown>[];
  reporter: Reporter;
  concurrency: number;
  /** Where to stream row outcomes as JSONL. Omit (SDK batch) to keep results in memory only. */
  outPath?: string;
  heal: boolean;
  /**
   * Max mid-run repairs during the fan-out (the warm-up row is separate and always heals under
   * --heal). Past this, drifted rows report drift as before. Default DEFAULT_MAX_HEALS.
   */
  maxHeals?: number;
  failFast: boolean;
  timeoutMs: number;
  /** Resume: skip rows already present in the out file (by index, or by `key` column). */
  resume: boolean;
  /** Stable-identity column for resume; falls back to row index when absent. */
  key?: string;
  /** Read row output from the per-row store at this key instead of the last eval value. */
  outKey?: string;
  /** Row index to run headed (visible) while the rest stay headless. */
  watch?: number;
  /** Skip the interactive "run remaining?" prompt (set for --json/--quiet/non-TTY/--yes). */
  yes: boolean;
  /** Prompt hook for the warm-up confirmation; default reads from a TTY readline. */
  confirm?: (rowsRemaining: number, row0: RowOutcome) => Promise<boolean>;
  /** Injected replay (default: the real Chrome-launching replayTrace). */
  replay?: ReplayFn;
  /** Injected profile copy (default: fs.cpSync with the lock-file filter). */
  copyProfile?: (src: string, worker: number) => string;
  signal?: AbortSignal;
}

// ── CSV / JSONL loaders (hand-rolled, zero deps) ────────────────────────────────

/**
 * Parse CSV into row objects keyed by header. Handles quoted fields, commas/newlines inside
 * quotes, doubled-quote escapes, and CRLF. Unquoted cells are trimmed. Throws on an unclosed quote.
 */
export function parseCSV(content: string): Record<string, string>[] {
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quoted = false; // this cell started with a quote (so don't trim it)
  let i = 0;

  const pushCell = () => {
    row.push(quoted ? cell : cell.trim());
    cell = "";
    quoted = false;
  };
  const pushRow = () => {
    pushCell();
    // skip blank lines (a single empty cell from a bare newline)
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      // A field is quoted if the only thing before the opening quote is whitespace; drop it.
      inQuotes = true;
      quoted = true;
      cell = "";
      i++;
      continue;
    }
    if (ch === ",") {
      pushCell();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (inQuotes) throw new Error("CSV parse error: unclosed quoted field");
  // flush trailing cell/row if the file did not end in a newline
  if (cell !== "" || row.length > 0) pushRow();

  if (rows.length === 0) return [];
  const headers = rows[0]!;
  return rows.slice(1).map((r) => {
    // null-proto so a header literally named "__proto__" is a normal data column, not a pollution
    // vector or a silently-dropped cell (a dataset can come from an untrusted source).
    const obj: Record<string, string> = Object.create(null);
    headers.forEach((h, idx) => {
      obj[h] = r[idx] ?? "";
    });
    return obj;
  });
}

/** Parse JSONL (one JSON object per line). Skips blank lines; errors name the line number. */
export function parseJSONL(content: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = content.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`JSONL parse error at line ${ln + 1}: ${(e as Error).message}`);
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error(`JSONL parse error at line ${ln + 1}: expected a JSON object`);
    }
    const rec = obj as Record<string, unknown>;
    // JSON.parse can set an own "__proto__" key; drop it so it can never pollute downstream reads.
    if (Object.prototype.hasOwnProperty.call(rec, "__proto__")) delete rec["__proto__"];
    out.push(rec);
  }
  return out;
}

/** Load rows from a CSV/JSONL file, choosing the parser by extension with a content sniff fallback. */
export function loadData(path: string): Record<string, unknown>[] {
  const content = readFileSync(path, "utf8").replace(/^\uFEFF/, ""); // strip a UTF-8 BOM (Excel CSVs)
  const ext = extname(path).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") return parseJSONL(content);
  if (ext === ".csv") return parseCSV(content);
  // sniff: a leading "{" looks like JSONL, otherwise treat as CSV.
  return content.trimStart().startsWith("{") ? parseJSONL(content) : parseCSV(content);
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Coerce a row's values to strings for {{var}} interpolation (numbers/booleans -> their text). */
export function stringVars(row: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || v === null) continue;
    vars[k] = typeof v === "string" ? v : String(v);
  }
  return vars;
}

/** Stable identity for resume: the `key` column if given, else the numeric index. */
function rowKey(row: Record<string, unknown>, index: number, key?: string): string {
  if (key && row[key] !== undefined && row[key] !== null) return `k:${String(row[key])}`;
  return `i:${index}`;
}

/** Read already-completed identities out of an existing out JSONL (best-effort; bad lines ignored). */
function readCompleted(outPath: string, key?: string): Set<string> {
  const done = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(outPath, "utf8");
  } catch {
    return done; // no prior file -> nothing completed
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as RowOutcome;
      done.add(rowKey(o.input ?? {}, o.index, key));
    } catch {
      // ignore malformed lines
    }
  }
  return done;
}

/** Default profile copy: clone the persistent profile, excluding lock files Chrome holds open. */
function defaultCopyProfile(src: string, worker: number): string {
  const dst = mkdtempSync(join(tmpdir(), `pixelpi-profile-w${worker}-`));
  cpSync(src, dst, {
    recursive: true,
    filter: (s) => {
      const base = basename(s);
      return !base.includes("Singleton") && !base.endsWith(".lock");
    },
  });
  return dst;
}

/**
 * Race a promise against a per-row timeout. On timeout, abort `controller` so the underlying replay
 * actually tears down its Chrome (replay forwards the signal to launchChrome) instead of leaking it.
 */
function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Graft heals from the warm-up's executed clone back onto the shared template, preserving the
 * template's {{var}} values. Heal only ever rewrites act/fill TARGETS (the model re-finds the
 * element); we copy those structural fields and keep the template's value. Returns true if the
 * template changed (so the caller re-saves it). This is the ONLY place the shared trace is rewritten.
 */
function graftHeals(template: Trace, executed: Trace): boolean {
  let changed = false;
  const n = Math.min(template.steps.length, executed.steps.length);
  for (let i = 0; i < n; i++) {
    const t = template.steps[i]!;
    const e = executed.steps[i]!;
    if (t.tool === "act" && e.tool === "act") {
      const drifted =
        t.target.role !== e.target.role ||
        t.target.name !== e.target.name ||
        t.target.ordinal !== e.target.ordinal ||
        t.op !== e.op;
      if (drifted) {
        t.target = { ...e.target };
        t.op = e.op;
        changed = true;
      }
    } else if (t.tool === "fill" && e.tool === "fill" && t.fields.length === e.fields.length) {
      e.fields.forEach((ef, fi) => {
        const tf = t.fields[fi]!;
        if (
          tf.target.role !== ef.target.role ||
          tf.target.name !== ef.target.name ||
          tf.target.ordinal !== ef.target.ordinal
        ) {
          tf.target = { ...ef.target };
          changed = true;
        }
      });
    } else if (t.tool === "fill" && e.tool === "fill") {
      // Both fill but the field COUNT changed (the guard above did not fire). The per-field graft
      // cannot represent that, so replace the whole step. We lose the {{var}} values for this one
      // repaired step, but a structural fill heal is rare and re-tagging via `pixelpi vars`
      // recovers them; the alternative (leaving stale targets) is worse. Other same-tool steps
      // (nav/eval/store/act) are left untouched so their {{var}} template values are preserved.
      template.steps[i] = JSON.parse(JSON.stringify(e)) as TraceStep;
      changed = true;
    } else if (t.tool !== e.tool) {
      // The heal replaced a step with a different tool (e.g. an act became a nav). Replace it
      // wholesale; structural repair wins over the original literal.
      template.steps[i] = JSON.parse(JSON.stringify(e)) as TraceStep;
      changed = true;
    }
  }
  return changed;
}

/** Capture a row's output: the last eval value, overridden by the store at outKey when set. */
async function captureOutput(
  result: ReplayResult,
  store: MemoryStore,
  outKey?: string,
): Promise<unknown> {
  if (outKey) return store.get(outKey);
  return result.output;
}

// ── per-row execution ──────────────────────────────────────────────────────────

interface RowContext {
  index: number;
  worker: number;
  row: Record<string, unknown>;
  trace: Trace; // the SHARED trace; we clone+substitute per row, never mutate this for fan-out
  opts: RunOptions;
  replay: ReplayFn;
  /** Resolved profile dir for this row (the worker's copy, or the original/undefined). */
  profileDir?: string;
  heal: boolean; // the warm-up row, and any mid-run repair attempt; strict fan-out rows are false
  /**
   * Where replay may persist a heal. For a healing row this is a THROWAWAY path so replay never
   * writes concrete (substituted) values to the shared trace; run() grafts the heal back instead.
   */
  healTracePath: string;
  /** Healing rows only: receives the executed clone so run() can graft it onto the shared template. */
  onExecutedTrace?: (executed: Trace) => void;
  parentSignal?: AbortSignal;
}

/**
 * Run one row in isolation. Clones+substitutes the trace, builds a fresh MemoryStore, runs replay
 * with a per-row timeout that ACTUALLY aborts (its own controller chained to the parent signal),
 * and captures output. The profile copy lives one level up (per worker), so this is the hot path.
 * A row never rewrites the shared trace itself: substituteVars returns a clone, strict rows have
 * heal OFF, and a healing row persists to a throwaway tracePath that run() grafts back.
 */
async function runRow(rc: RowContext): Promise<RowOutcome> {
  const { index, worker, row, opts, replay } = rc;
  const start = Date.now();
  opts.reporter.onRowStart({ worker, index, input: row });

  const cloned = substituteVars(rc.trace, stringVars(row));
  const store = new MemoryStore();

  const headless = opts.watch === index ? false : opts.settings.headless;
  const settings: ResolvedSettings = { ...opts.settings, profileDir: rc.profileDir, headless };
  const total = rc.trace.steps.length;

  // Per-row controller chained to the parent (SIGINT) signal so a timeout actually aborts replay.
  // The listener is removed in finally so it does not accumulate on the shared parent signal.
  const rowAc = new AbortController();
  const onParentAbort = () => rowAc.abort();
  if (rc.parentSignal) {
    if (rc.parentSignal.aborted) rowAc.abort();
    else rc.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  try {
    const result = await withTimeout(
      replay({
        trace: cloned,
        settings,
        tracePath: rc.healTracePath,
        store,
        heal: rc.heal,
        signal: rowAc.signal,
        onStep: (step) => opts.reporter.onRowStep({ worker, index, step, total }),
      }),
      opts.timeoutMs,
      rowAc,
    );
    rc.onExecutedTrace?.(cloned);
    const output = await captureOutput(result, store, opts.outKey);
    return {
      index,
      input: row,
      ok: result.ok,
      output,
      drift: result.drift,
      ms: Date.now() - start,
    };
  } catch (e) {
    return {
      index,
      input: row,
      ok: false,
      error: (e as Error).message,
      ms: Date.now() - start,
    };
  } finally {
    rc.parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

// ── orchestration ──────────────────────────────────────────────────────────────

/**
 * Run a parametrized trace over rows. Validates required params before launching anything, runs
 * row 0 as a warm-up (healing if requested), seeds the ETA, optionally prompts, then fans out rows
 * 1..N-1 on a bounded pool. Under --heal, a mid-run drift takes the heal lock, repairs the shared
 * trace once, and other drifted rows retry against the repair. Returns the summary.
 */
export async function run(opts: RunOptions): Promise<RunSummary> {
  const replay = opts.replay ?? (defaultReplayTrace as ReplayFn);
  const copyProfile = opts.copyProfile ?? defaultCopyProfile;
  const t0 = Date.now();

  // 1. Validate required params for EVERY row before any browser launches. Fatal, names the gap.
  for (let i = 0; i < opts.rows.length; i++) {
    const v = validateParams(opts.trace, opts.rows[i]!);
    if ("missing" in v) {
      throw new Error(
        `row ${i} is missing required param(s): ${v.missing.join(", ")}. ` +
          `Provide them as columns/keys in the data or via --<param>.`,
      );
    }
  }

  // 2. Resume: skip rows already present in the out file. On a FRESH run, truncate the out file so
  // we never mix stale rows from a prior unrelated run (which a later --resume would misread).
  if (opts.outPath && !opts.resume) writeFileSync(opts.outPath, "", "utf8");
  const completed =
    opts.resume && opts.outPath ? readCompleted(opts.outPath, opts.key) : new Set<string>();
  const pending = opts.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => !completed.has(rowKey(row, index, opts.key)));
  const skipped = opts.rows.length - pending.length;

  // 3. Logged-in fan-out isolation: copy the profile ONCE per worker (so N Chromes do not fight
  // over one lock), cached and reused across that worker's rows; cleaned up at the end. Logged-out
  // rows (profileDir undefined) get a fresh disposable profile from launchChrome. If the first copy
  // fails (locked/missing profile), degrade to concurrency 1 against the original profile.
  let concurrency = opts.concurrency;
  const workerProfiles = new Map<number, string>();
  let profileCopyFailed = false;
  const profileFor = (worker: number): string | undefined => {
    if (!opts.settings.profileDir || profileCopyFailed) return opts.settings.profileDir;
    const cached = workerProfiles.get(worker);
    if (cached) return cached;
    const dir = copyProfile(opts.settings.profileDir, worker);
    workerProfiles.set(worker, dir);
    return dir;
  };
  if (opts.settings.profileDir) {
    try {
      profileFor(0); // probe up front; reused by the warm-up row.
    } catch {
      profileCopyFailed = true;
      concurrency = 1;
      workerProfiles.clear();
    }
  }

  // All temp dirs (the throwaway heal trace + every per-worker profile copy) are removed in the
  // finally below, so a throw or early return anywhere in the orchestration never orphans them.
  // One throwaway path serves every heal: heals are serialized by the heal lock, so they cannot
  // collide on it.
  let healTempTrace: string | undefined;
  const cleanup = (): void => {
    if (healTempTrace) {
      try {
        rmSync(join(healTempTrace, ".."), { recursive: true, force: true });
      } catch {
        /* best-effort cleanup of the throwaway dir */
      }
    }
    for (const dir of workerProfiles.values()) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Chrome may still hold a handle briefly; non-fatal */
      }
    }
  };

  opts.reporter.start({ trace: opts.trace.task, total: opts.rows.length, workers: concurrency });
  if (profileCopyFailed) {
    opts.reporter.warn?.(
      "profile copy failed; running 1 row at a time against the original profile.",
    );
  }

  const counts = { ok: 0, drift: 0, error: 0 };
  let aborted = false;
  // Mid-run heal state. `healLock` is held by the one worker currently repairing; `traceGeneration`
  // bumps ONLY when a repair actually changed the shared template, so waiters can tell a real
  // repair from a heal that produced nothing (and skip a pointless retry).
  const maxHeals = opts.maxHeals ?? DEFAULT_MAX_HEALS;
  let healLock: Promise<void> | null = null;
  let healsUsed = 0;
  let traceGeneration = 0;
  let budgetWarned = false;
  const ac = new AbortController();
  // If a parent signal aborts (SIGINT), record it in the summary AND abort our internal controller,
  // so the CLI's `summary.aborted && ac.signal.aborted` maps a real Ctrl-C to exit code 130.
  if (opts.signal) {
    if (opts.signal.aborted) {
      aborted = true;
      ac.abort();
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          ac.abort();
        },
        { once: true },
      );
    }
  }

  const tally = (o: RowOutcome): void => {
    if (o.ok) counts.ok++;
    else if (o.drift) counts.drift++;
    else counts.error++;
    if (opts.outPath) appendFileSync(opts.outPath, JSON.stringify(o) + "\n", "utf8");
    if (opts.failFast && o.error) {
      aborted = true;
      ac.abort();
    }
  };

  let ran = 0;
  const summarize = (): RunSummary => ({
    total: opts.rows.length,
    ran,
    skipped,
    ok: counts.ok,
    drift: counts.drift,
    error: counts.error,
    healed: healsUsed,
    ms: Date.now() - t0,
    aborted,
    outPath: opts.outPath ?? "",
  });

  try {
    if (pending.length === 0) {
      const summary = summarize();
      opts.reporter.done(summary);
      return summary;
    }

    // 4. Warm-up: run the first PENDING row alone (worker 0). heal applies only here. The warm-up's
    // replay persists to a THROWAWAY path (never the shared trace) so the row's CONCRETE substituted
    // values can never overwrite the {{var}} template on disk. graftHeals + saveTrace below is the
    // ONLY place the shared trace is rewritten, and it keeps the template's {{var}} values.
    const first = pending[0]!;
    if (opts.heal) {
      healTempTrace = join(mkdtempSync(join(tmpdir(), "pixelpi-heal-")), "trace.json");
    }
    // Graft a heal from an executed clone back onto the shared template and persist it. Shared by
    // the warm-up row and every mid-run repair; the ONLY place the shared trace is rewritten.
    const writeBackHeal = (executed: Trace): void => {
      if (!opts.heal) return;
      if (graftHeals(opts.trace, executed)) {
        saveTrace(opts.tracePath, opts.trace);
        traceGeneration++;
      }
    };
    const row0 = await runRow({
      index: first.index,
      worker: 0,
      row: first.row,
      trace: opts.trace,
      opts,
      replay,
      profileDir: profileFor(0),
      healTracePath: healTempTrace ?? opts.tracePath,
      parentSignal: ac.signal,
      heal: opts.heal,
      onExecutedTrace: writeBackHeal,
    });
    ran++;
    tally(row0);
    opts.reporter.onRowDone({ worker: 0, outcome: row0 });

    // 4. Prompt (unless suppressed / aborted): confirm before fanning out the rest.
    const rest = pending.slice(1);
    if (!aborted && rest.length > 0 && !opts.yes && opts.confirm) {
      const go = await opts.confirm(rest.length, row0);
      if (!go) {
        const summary = summarize();
        opts.reporter.done(summary);
        return summary;
      }
    }

    // 5. Fan out rows 1..N-1 on a bounded worker pool. Rows replay STRICTLY (heal off) on the fast
    // path; a drift under --heal escalates to the shared mid-run repair below.
    if (!aborted && rest.length > 0) {
      let next = 0;
      const poolSize = Math.max(1, Math.min(concurrency, rest.length));

      const replayRow = (item: { row: Record<string, unknown>; index: number }, workerId: number, heal: boolean) =>
        runRow({
          index: item.index,
          worker: workerId,
          row: item.row,
          trace: opts.trace,
          opts,
          replay,
          profileDir: profileFor(workerId),
          // Strict rows never persist, so the path is unused; a healing row writes its CONCRETE
          // substituted values to the throwaway path and run() grafts the repair back instead.
          healTracePath: heal ? (healTempTrace ?? opts.tracePath) : opts.tracePath,
          parentSignal: ac.signal,
          heal,
          onExecutedTrace: heal ? writeBackHeal : undefined,
        });

      /**
       * A fan-out row drifted. The site probably changed mid-batch, so repair the shared trace ONCE
       * and let every other drifted row reuse that repair instead of paying for its own:
       *   - the template already moved since this row started -> retry strictly against it (free).
       *   - a repair is in flight -> wait it out, then re-check.
       *   - neither, and budget remains -> claim a slot and heal this row with the model.
       * Returns the row's final outcome: the strict drift if nothing could be done.
       *
       * The loop cannot spin: each pass either consumes a template generation or a heal slot (both
       * bounded by maxHeals), or returns.
       */
      const healAndRetry = async (
        item: { row: Record<string, unknown>; index: number },
        workerId: number,
        firstDrift: RowOutcome,
        genBefore: number,
      ): Promise<RowOutcome> => {
        let drifted = firstDrift;
        let gen = genBefore;
        for (;;) {
          if (ac.signal.aborted) return drifted;

          // Someone repaired the template since this row began replaying (it may have landed while
          // we were drifting, not just while we waited). Retry against the repair for free.
          if (traceGeneration > gen) {
            gen = traceGeneration;
            const retried = await replayRow(item, workerId, false);
            if (!retried.drift) return retried;
            drifted = retried; // still stale against the newest template; fall through
            continue;
          }

          // A repair is in flight for the same change. Wait rather than spend a second model run.
          if (healLock) {
            await healLock;
            continue;
          }

          if (healsUsed >= maxHeals) {
            if (!budgetWarned) {
              budgetWarned = true;
              opts.reporter.warn?.(
                `heal budget spent (${maxHeals}); remaining drifted rows are reported, not repaired. ` +
                  `Re-record with --record, or raise --max-heals.`,
              );
            }
            return drifted;
          }

          // Claiming is synchronous with the checks above (no await in between), so two workers can
          // never both take the lock.
          healsUsed++;
          opts.reporter.warn?.(
            `row ${item.index} drifted at step ${drifted.drift?.step ?? "?"}; ` +
              `repairing the trace (heal ${healsUsed}/${maxHeals}) so the remaining rows reuse the fix.`,
          );
          let release!: () => void;
          healLock = new Promise<void>((r) => (release = r));
          try {
            return await replayRow(item, workerId, true);
          } finally {
            healLock = null;
            release();
          }
        }
      };

      const worker = async (workerId: number): Promise<void> => {
        while (true) {
          if (ac.signal.aborted) return;
          const slot = next++;
          if (slot >= rest.length) return;
          const item = rest[slot]!;
          const genBefore = traceGeneration;
          let outcome = await replayRow(item, workerId, false);
          if (opts.heal && outcome.drift && !ac.signal.aborted) {
            outcome = await healAndRetry(item, workerId, outcome, genBefore);
          }
          ran++;
          tally(outcome);
          opts.reporter.onRowDone({ worker: workerId, outcome });
        }
      };

      await Promise.all(Array.from({ length: poolSize }, (_, w) => worker(w + 1)));
    }

    const summary = summarize();
    opts.reporter.done(summary);
    return summary;
  } finally {
    cleanup();
  }
}
