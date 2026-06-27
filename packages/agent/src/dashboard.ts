// Reporters for `pixelpi run`. ONE interface, three implementations selected automatically:
//   - TTY default: a hand-rolled ANSI live dashboard (cursor-up + clear + redraw, no new dep).
//   - --json / non-TTY: NDJSON events (row_start, row_step, row_done, summary).
//   - --quiet: only the final summary line.
//
// Workers MUST NOT write to stdout directly. Every byte goes through a Reporter so the live
// dashboard never gets corrupted by interleaved output. run.ts depends only on this interface;
// the concrete reporters and selectReporter() are defined here.

import type { ReplayStep } from "./replay";
import type { RowOutcome, RunSummary } from "./run";

/** The events run.ts streams to whichever reporter is active. */
export interface Reporter {
  /** Called once before any rows run: total row count, worker count, trace name. */
  start(info: { trace: string; total: number; workers: number }): void;
  /** A row has begun executing on a worker. */
  onRowStart(ev: { worker: number; index: number; input: Record<string, unknown> }): void;
  /** A replay step finished for a row (for live per-worker progress). */
  onRowStep(ev: { worker: number; index: number; step: ReplayStep; total: number }): void;
  /** A row completed (ok, drift, error, or timeout). */
  onRowDone(ev: { worker: number; outcome: RowOutcome }): void;
  /** The whole batch finished; emit the summary line and tear down any live UI. */
  done(summary: RunSummary): void;
  /** Optional out-of-band warning (e.g. profile copy fell back to concurrency 1). */
  warn?(message: string): void;
  /**
   * Optional: reset the live UI's paint anchor so the next paint redraws from scratch instead of
   * scrolling over lines it did not draw. Used after an interactive prompt wrote to the same region.
   */
  resetAnchor?(): void;
}

// ── ANSI helpers (same palette/style as render.ts; kept local so each reporter is self-contained) ──

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

/** Collapse whitespace and clip to max with an overflow marker (mirrors render.ts truncate). */
function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** A short label for a row's input: the first param value, else the compact JSON. */
function rowLabel(input: Record<string, unknown>): string {
  const vals = Object.values(input);
  if (vals.length === 1 && vals[0] != null) return String(vals[0]);
  return JSON.stringify(input);
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function progressBar(done: number, total: number, width: number): string {
  const frac = total > 0 ? done / total : 0;
  const filled = Math.round(frac * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

// ── NDJSON reporter (--json / non-TTY) ──────────────────────────────────────────

/**
 * Emits one JSON object per line for machine consumption: row_start, row_step, row_done, summary.
 * The `start` event has no NDJSON line of its own (it is just a lead-in); everything else maps 1:1.
 */
export class NdjsonReporter implements Reporter {
  private write: (line: string) => void;
  constructor(write: (line: string) => void = (l) => process.stdout.write(l + "\n")) {
    this.write = write;
  }
  start(_info: { trace: string; total: number; workers: number }): void {
    // no leading event; the first NDJSON line is the first row_start.
  }
  onRowStart(ev: { worker: number; index: number; input: Record<string, unknown> }): void {
    this.write(JSON.stringify({ type: "row_start", index: ev.index, worker: ev.worker, input: ev.input }));
  }
  onRowStep(ev: { worker: number; index: number; step: ReplayStep; total: number }): void {
    this.write(
      JSON.stringify({
        type: "row_step",
        index: ev.index,
        worker: ev.worker,
        step: ev.step.i,
        total: ev.total,
        tool: ev.step.tool,
        status: ev.step.status,
      }),
    );
  }
  onRowDone(ev: { worker: number; outcome: RowOutcome }): void {
    const o = ev.outcome;
    this.write(
      JSON.stringify({
        type: "row_done",
        index: o.index,
        ok: o.ok,
        output: o.output,
        drift: o.drift,
        error: o.error,
        ms: o.ms,
      }),
    );
  }
  warn(message: string): void {
    this.write(JSON.stringify({ type: "warn", message }));
  }
  done(summary: RunSummary): void {
    this.write(JSON.stringify({ type: "summary", ...summary }));
  }
}

// ── Quiet reporter (--quiet) ─────────────────────────────────────────────────────

/** Emits nothing until the very end, then a single grep-friendly summary line. */
export class QuietReporter implements Reporter {
  private write: (line: string) => void;
  constructor(write: (line: string) => void = (l) => process.stdout.write(l + "\n")) {
    this.write = write;
  }
  start(_info: { trace: string; total: number; workers: number }): void {}
  onRowStart(_ev: { worker: number; index: number; input: Record<string, unknown> }): void {}
  onRowStep(_ev: { worker: number; index: number; step: ReplayStep; total: number }): void {}
  onRowDone(_ev: { worker: number; outcome: RowOutcome }): void {}
  warn(message: string): void {
    this.write(`warning: ${message}`);
  }
  done(summary: RunSummary): void {
    this.write(summaryLine(summary));
  }
}

/** The one-line batch summary shared by quiet mode and the dashboard's teardown. */
function summaryLine(s: RunSummary): string {
  const parts = [`${s.ok} ok`, `${s.drift} drift`, `${s.error} error`];
  const aborted = s.aborted ? ", aborted" : "";
  const skipped = s.skipped > 0 ? `, ${s.skipped} skipped` : "";
  return `completed ${s.ran}/${s.total} rows: ${parts.join(", ")}${skipped}${aborted} in ${humanMs(s.ms)}`;
}

// ── ANSI live dashboard (TTY default) ────────────────────────────────────────────

interface WorkerLine {
  index: number;
  label: string;
  step: number;
  total: number;
  tool: string;
  active: boolean;
}

/**
 * A hand-rolled ANSI live dashboard. It owns its redraw region: a header + progress bar, one line
 * per worker showing the row it is on and its step, a counts line (ok/drift/err + tokens), and a
 * rolling tail of the most recent completed rows. Redraw is done by moving the cursor up over the
 * previously drawn block and clearing each line, then re-emitting. No third-party dependency.
 *
 * render() builds the full block as a string so it can be snapshot-tested deterministically.
 */
export class AnsiDashboard implements Reporter {
  private write: (s: string) => void;
  private now: () => number;
  private color: boolean;

  private trace = "";
  private total = 0;
  private workers = 0;
  private doneCount = 0;
  private counts = { ok: 0, drift: 0, error: 0 };
  private startMs = 0;
  private firstDoneAt = 0;
  private linesByWorker = new Map<number, WorkerLine>();
  private tail: RowOutcome[] = [];
  private prevLines = 0; // how many lines the last paint emitted (for cursor-up)
  private tailMax = 5;

  constructor(opts?: { write?: (s: string) => void; now?: () => number; color?: boolean }) {
    this.write = opts?.write ?? ((s) => process.stdout.write(s));
    this.now = opts?.now ?? (() => Date.now());
    this.color = opts?.color ?? true;
    if (typeof process !== "undefined" && process.on) {
      process.on("SIGWINCH", () => this.paint());
    }
  }

  private c(code: string, s: string): string {
    return this.color ? `${code}${s}${C.reset}` : s;
  }

  /** Current best ETA: seeded from the first completed row, refined by the running average. */
  private eta(): string {
    if (this.doneCount === 0 || this.firstDoneAt === 0) return "--";
    const elapsed = this.now() - this.startMs;
    const avg = elapsed / this.doneCount;
    const remaining = this.total - this.doneCount;
    if (remaining <= 0) return "0s";
    return humanMs(avg * remaining);
  }

  /** Build the entire dashboard block as a single string (no cursor control). Deterministic. */
  render(): string {
    const lines: string[] = [];
    const pct = this.total > 0 ? Math.round((this.doneCount / this.total) * 100) : 0;
    const bar = progressBar(this.doneCount, this.total, 24);
    lines.push(
      this.c(C.bold, `pixelpi run ${truncate(this.trace, 40)}`) +
        this.c(C.dim, `  ${this.workers} workers`),
    );
    lines.push(
      `${this.c(C.cyan, bar)} ${this.doneCount}/${this.total} ${pct}%` +
        this.c(C.dim, `  ETA ${this.eta()}`),
    );

    // worker lines, sorted by worker id for a stable display
    const ids = Array.from(this.linesByWorker.keys()).sort((a, b) => a - b);
    for (const id of ids) {
      const w = this.linesByWorker.get(id)!;
      const tag = this.c(C.dim, `w${id} >`);
      if (!w.active) {
        lines.push(`${tag} ${this.c(C.dim, "idle")}`);
        continue;
      }
      const label = this.c(C.cyan, `"${truncate(w.label, 32)}"`);
      const prog = this.c(C.dim, `step ${w.step}/${w.total} ${w.tool}`);
      lines.push(`${tag} row ${w.index} ${label}  ${prog}`);
    }

    // counts line (tokens are always 0 for zero-token replay; est saved is informational)
    lines.push(
      this.c(C.green, `${this.counts.ok} ok`) +
        "  " +
        this.c(C.yellow, `${this.counts.drift} drift`) +
        "  " +
        this.c(C.red, `${this.counts.error} err`) +
        this.c(C.dim, `  tokens 0`),
    );

    // rolling tail of recent completions
    for (const o of this.tail) {
      const mark = o.ok
        ? this.c(C.green, "✓")
        : o.drift
          ? this.c(C.yellow, "~")
          : this.c(C.red, "✗");
      const out = o.error
        ? truncate(o.error, 40)
        : o.drift
          ? `drift at step ${o.drift.step}`
          : truncate(outString(o.output), 40);
      lines.push(`${mark} row ${o.index} ${this.c(C.dim, out)} ${this.c(C.dim, `(${humanMs(o.ms)})`)}`);
    }

    return lines.join("\n");
  }

  /** Repaint in place: move up over the previous block, clear each line, emit the new block. */
  private paint(): void {
    const block = this.render();
    const lineCount = block.split("\n").length;
    let out = "";
    if (this.prevLines > 0) {
      // move cursor up to the top of the previous block
      out += `\x1b[${this.prevLines}A`;
    }
    // clear from cursor to end of screen, then draw
    out += "\x1b[0J" + block + "\n";
    this.prevLines = lineCount;
    this.write(out);
  }

  start(info: { trace: string; total: number; workers: number }): void {
    this.trace = info.trace;
    this.total = info.total;
    this.workers = info.workers;
    this.startMs = this.now();
    this.paint();
  }

  onRowStart(ev: { worker: number; index: number; input: Record<string, unknown> }): void {
    this.linesByWorker.set(ev.worker, {
      index: ev.index,
      label: rowLabel(ev.input),
      step: 0,
      total: 0,
      tool: "",
      active: true,
    });
    this.paint();
  }

  onRowStep(ev: { worker: number; index: number; step: ReplayStep; total: number }): void {
    const w = this.linesByWorker.get(ev.worker);
    if (!w) return;
    w.step = ev.step.i + 1;
    w.total = ev.total;
    w.tool = ev.step.tool;
    this.paint();
  }

  onRowDone(ev: { worker: number; outcome: RowOutcome }): void {
    const o = ev.outcome;
    this.doneCount++;
    if (o.ok) this.counts.ok++;
    else if (o.drift) this.counts.drift++;
    else this.counts.error++;
    if (this.firstDoneAt === 0) this.firstDoneAt = this.now();
    const w = this.linesByWorker.get(ev.worker);
    if (w) w.active = false;
    this.tail.push(o);
    if (this.tail.length > this.tailMax) this.tail.shift();
    this.paint();
  }

  warn(message: string): void {
    // Print the warning above the live block, then re-anchor so the next paint does not scroll
    // over it. Written as a standalone line; the dashboard repaints fresh on the next event.
    this.write(this.c(C.yellow, `warning: ${message}`) + "\n");
    this.prevLines = 0;
  }

  /** Reset the paint anchor so the next paint redraws from scratch (after a prompt wrote here). */
  resetAnchor(): void {
    this.prevLines = 0;
  }

  done(summary: RunSummary): void {
    // final repaint of state, then the summary line below the block.
    this.paint();
    this.write(summaryLine(summary) + "\n");
  }
}

/** Render any output value to a short string for the tail/done lines. */
function outString(output: unknown): string {
  if (output === undefined) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

// ── selection ────────────────────────────────────────────────────────────────────

/**
 * Pick a reporter from flags + tty: --quiet wins (only the final line); --json or a non-TTY stdout
 * gets NDJSON; otherwise the live ANSI dashboard. (Caller computes tty from process.stdout.isTTY.)
 */
export function selectReporter(opts: { json: boolean; quiet: boolean; tty: boolean }): Reporter {
  if (opts.quiet) return new QuietReporter();
  if (opts.json || !opts.tty) return new NdjsonReporter();
  return new AnsiDashboard();
}
