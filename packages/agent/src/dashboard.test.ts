import { describe, it, expect } from "vitest";
import {
  AnsiDashboard,
  NdjsonReporter,
  QuietReporter,
  selectReporter,
} from "./dashboard";
import type { ReplayStep } from "./replay";
import type { RowOutcome, RunSummary } from "./run";

function outcome(over: Partial<RowOutcome> = {}): RowOutcome {
  return { index: 0, input: { query: "wireless mouse" }, ok: true, output: "Results", ms: 1500, ...over };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    total: 3,
    ran: 3,
    skipped: 0,
    ok: 3,
    drift: 0,
    error: 0,
    ms: 4500,
    aborted: false,
    outPath: "run_out.jsonl",
    ...over,
  };
}

function step(i: number, tool: string): ReplayStep {
  return { i, tool, label: tool, status: "ok" };
}

describe("NdjsonReporter", () => {
  it("emits row_start, row_step, row_done, summary with the right fields", () => {
    const lines: string[] = [];
    const r = new NdjsonReporter((l) => lines.push(l));
    r.start({ trace: "search {{query}}", total: 2, workers: 4 });
    r.onRowStart({ worker: 1, index: 0, input: { query: "mouse" } });
    r.onRowStep({ worker: 1, index: 0, step: step(0, "nav"), total: 2 });
    r.onRowDone({ worker: 1, outcome: outcome({ index: 0, output: "Title", ms: 900 }) });
    r.done(summary({ total: 2, ran: 2, ok: 2 }));

    // start emits nothing; the first line is the row_start.
    expect(lines).toHaveLength(4);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toEqual({ type: "row_start", index: 0, worker: 1, input: { query: "mouse" } });
    expect(parsed[1]).toMatchObject({ type: "row_step", index: 0, worker: 1, step: 0, total: 2, tool: "nav", status: "ok" });
    expect(parsed[2]).toMatchObject({ type: "row_done", index: 0, ok: true, output: "Title", ms: 900 });
    expect(parsed[3]).toMatchObject({ type: "summary", total: 2, ran: 2, ok: 2 });
  });

  it("carries drift and error through row_done", () => {
    const lines: string[] = [];
    const r = new NdjsonReporter((l) => lines.push(l));
    r.onRowDone({ worker: 2, outcome: outcome({ index: 5, ok: false, drift: { step: 3, reason: "no match" }, output: undefined }) });
    r.onRowDone({ worker: 3, outcome: outcome({ index: 6, ok: false, error: "timeout after 60000ms", output: undefined }) });
    const a = JSON.parse(lines[0]!);
    const b = JSON.parse(lines[1]!);
    expect(a.drift).toEqual({ step: 3, reason: "no match" });
    expect(a.ok).toBe(false);
    expect(b.error).toBe("timeout after 60000ms");
  });
});

describe("QuietReporter", () => {
  it("emits nothing until done, then one summary line", () => {
    const lines: string[] = [];
    const r = new QuietReporter((l) => lines.push(l));
    r.start({ trace: "t", total: 3, workers: 2 });
    r.onRowStart({ worker: 1, index: 0, input: {} });
    r.onRowDone({ worker: 1, outcome: outcome() });
    expect(lines).toHaveLength(0);
    r.done(summary({ ok: 2, drift: 1, error: 0 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("completed 3/3 rows: 2 ok, 1 drift, 0 error in 4.5s");
  });

  it("notes skipped and aborted in the summary line", () => {
    const lines: string[] = [];
    const r = new QuietReporter((l) => lines.push(l));
    r.done(summary({ total: 10, ran: 5, skipped: 5, ok: 4, error: 1, aborted: true, ms: 12000 }));
    expect(lines[0]).toBe("completed 5/10 rows: 4 ok, 0 drift, 1 error, 5 skipped, aborted in 12.0s");
  });
});

describe("AnsiDashboard", () => {
  it("render() produces a stable snapshot string for a known state (no color)", () => {
    // Clock: start at 1000, then 2500 from the first onRowDone onward (elapsed 1500ms over 1 done,
    // 3 remaining -> ETA 4.5s). Deterministic and exercises the running-average ETA.
    let t = 1000;
    const d = new AnsiDashboard({ write: () => {}, color: false, now: () => t });
    d.start({ trace: "search {{query}}", total: 4, workers: 2 });
    d.onRowStart({ worker: 1, index: 0, input: { query: "wireless mouse" } });
    d.onRowStep({ worker: 1, index: 0, step: step(1, "nav"), total: 6 });
    d.onRowStart({ worker: 2, index: 1, input: { query: "keyboard" } });
    d.onRowStep({ worker: 2, index: 1, step: step(0, "act"), total: 6 });
    t = 2500;
    d.onRowDone({ worker: 1, outcome: outcome({ index: 0, output: "Results page", ms: 1500 }) });

    expect(d.render()).toMatchInlineSnapshot(`
      "pixelpi run search {{query}}  2 workers
      ██████░░░░░░░░░░░░░░░░░░ 1/4 25%  ETA 4.5s
      w1 > idle
      w2 > row 1 "keyboard"  step 1/6 act
      1 ok  0 drift  0 err  tokens 0
      ✓ row 0 Results page (1.5s)"
    `);
  });

  it("counts ok/drift/error and keeps a bounded rolling tail", () => {
    const d = new AnsiDashboard({ write: () => {}, color: false, now: () => 1000 });
    d.start({ trace: "t", total: 10, workers: 1 });
    for (let i = 0; i < 8; i++) {
      d.onRowStart({ worker: 1, index: i, input: { q: `row${i}` } });
      const ok = i % 3 !== 0;
      d.onRowDone({ worker: 1, outcome: outcome({ index: i, ok, output: ok ? "v" : undefined, drift: ok ? undefined : { step: 1, reason: "x" }, ms: 100 }) });
    }
    const out = d.render();
    // 8 rows done: indices 0,3,6 drift (3), the rest ok (5)
    expect(out).toContain("5 ok");
    expect(out).toContain("3 drift");
    expect(out).toContain("0 err");
    // tail is capped at 5 entries: only the most recent rows appear
    expect(out).not.toContain("row 0 ");
    expect(out).not.toContain("row 2 ");
    expect(out).toContain("row 7 ");
    expect(out).toContain("8/10");
  });

  it("paint() moves the cursor up over the previous block on redraw", () => {
    const chunks: string[] = [];
    const d = new AnsiDashboard({ write: (s) => chunks.push(s), color: false, now: () => 1000 });
    d.start({ trace: "t", total: 2, workers: 1 });
    const first = chunks[0]!;
    // first paint has no cursor-up (nothing drawn before it) but clears to end of screen
    expect(first).not.toMatch(/\x1b\[\d+A/);
    expect(first).toContain("\x1b[0J");
    d.onRowStart({ worker: 1, index: 0, input: {} });
    const second = chunks[1]!;
    // second paint moves up over the first block's line count
    expect(second).toMatch(/\x1b\[\d+A/);
  });
});

describe("selectReporter", () => {
  it("--quiet wins over everything", () => {
    expect(selectReporter({ json: true, quiet: true, tty: true })).toBeInstanceOf(QuietReporter);
    expect(selectReporter({ json: false, quiet: true, tty: false })).toBeInstanceOf(QuietReporter);
  });
  it("--json or non-TTY selects NDJSON", () => {
    expect(selectReporter({ json: true, quiet: false, tty: true })).toBeInstanceOf(NdjsonReporter);
    expect(selectReporter({ json: false, quiet: false, tty: false })).toBeInstanceOf(NdjsonReporter);
  });
  it("interactive TTY with no flags selects the ANSI dashboard", () => {
    expect(selectReporter({ json: false, quiet: false, tty: true })).toBeInstanceOf(AnsiDashboard);
  });
});
