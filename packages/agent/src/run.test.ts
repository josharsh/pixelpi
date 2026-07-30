import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Store } from "@josharsh/pixelpi-core";
import type { ResolvedSettings } from "./config";
import type { Trace } from "./trace";
import { run, parseCSV, parseJSONL, type ReplayFn, type RowOutcome, type RunSummary } from "./run";
import type { Reporter } from "./dashboard";

const settings: ResolvedSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  headless: true,
  storePath: ".pixelpi-store.json",
  keySource: "none",
  envVar: "ANTHROPIC_API_KEY",
};

/** A trace that searches for {{query}} and evals a result; params declares query required. */
function traceWithEval(): Trace {
  return {
    version: 1,
    task: "search {{query}}",
    model: "m",
    createdAt: "now",
    steps: [
      { tool: "nav", input: { action: "goto", arg: "https://x/?q={{query}}" } },
      { tool: "eval", input: { fn: "return document.title" } },
    ],
    params: [{ name: "query", example: "wireless mouse", required: true }],
  };
}

/** A no-op reporter that records the events run() emits, for assertions. */
function spyReporter(): Reporter & { events: string[]; summary?: RunSummary; outcomes: RowOutcome[] } {
  const events: string[] = [];
  const outcomes: RowOutcome[] = [];
  const r: Reporter & { events: string[]; summary?: RunSummary; outcomes: RowOutcome[] } = {
    events,
    outcomes,
    start: (i) => events.push(`start:${i.total}:${i.workers}`),
    onRowStart: (e) => events.push(`rowStart:${e.index}:w${e.worker}`),
    onRowStep: () => {},
    onRowDone: (e) => {
      outcomes.push(e.outcome);
      events.push(`rowDone:${e.outcome.index}`);
    },
    done: (s) => {
      r.summary = s;
      events.push(`done:${s.ok}/${s.total}`);
    },
  };
  return r;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pixelpi-run-test-"));
});

// ── CSV / JSONL parsing ─────────────────────────────────────────────────────

describe("parseCSV", () => {
  it("parses a simple table mapping headers to values", () => {
    expect(parseCSV("a,b\n1,2\n3,4\n")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("handles quoted fields with commas and newlines", () => {
    const rows = parseCSV('name,value\n"John Doe","123\nMain St"\n');
    expect(rows).toEqual([{ name: "John Doe", value: "123\nMain St" }]);
  });

  it("handles escaped doubled quotes inside a quoted field", () => {
    const rows = parseCSV('name,value\n"John ""the King""",123\n');
    expect(rows).toEqual([{ name: 'John "the King"', value: "123" }]);
  });

  it("skips trailing/blank lines and keeps empty quoted fields", () => {
    expect(parseCSV("a,b\nc,d\n\n")).toEqual([{ a: "c", b: "d" }]);
    expect(parseCSV('a,b\n"",2\n')).toEqual([{ a: "", b: "2" }]);
  });

  it("trims unquoted cells but not quoted ones", () => {
    expect(parseCSV('a,b\n x , " y "\n')).toEqual([{ a: "x", b: " y " }]);
  });

  it("normalizes CRLF and handles no trailing newline", () => {
    expect(parseCSV("a,b\r\n1,2")).toEqual([{ a: "1", b: "2" }]);
  });

  it("throws on an unclosed quote", () => {
    expect(() => parseCSV('a,b\n"oops,2\n')).toThrow(/unclosed/);
  });

  it("returns [] for empty input", () => {
    expect(parseCSV("")).toEqual([]);
  });
});

describe("parseJSONL", () => {
  it("parses one object per line and skips blanks", () => {
    expect(parseJSONL('{"q":"a"}\n\n{"q":"b"}\n')).toEqual([{ q: "a" }, { q: "b" }]);
  });

  it("errors with a line number on bad JSON", () => {
    expect(() => parseJSONL('{"q":"a"}\nnot json\n')).toThrow(/line 2/);
  });

  it("rejects a non-object line", () => {
    expect(() => parseJSONL("[1,2,3]\n")).toThrow(/expected a JSON object/);
  });
});

// ── orchestration ───────────────────────────────────────────────────────────

describe("run param validation", () => {
  it("fails BEFORE any replay when a required param is missing", async () => {
    let replayCalls = 0;
    const replay: ReplayFn = async () => {
      replayCalls++;
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    await expect(
      run({
        trace: traceWithEval(),
        tracePath: join(tmp, "t.json"),
        settings,
        rows: [{ query: "ok" }, { notquery: "x" }],
        reporter,
        concurrency: 4,
        outPath: join(tmp, "out.jsonl"),
        heal: false,
        failFast: false,
        timeoutMs: 1000,
        resume: false,
        yes: true,
        replay,
      }),
    ).rejects.toThrow(/missing required param.*query/);
    expect(replayCalls).toBe(0);
  });
});

describe("run output capture", () => {
  it("captures result.output (last eval value) per row", async () => {
    const replay: ReplayFn = async (o) => ({ ok: true, steps: [], output: `title-${o.trace.steps[0]}` });
    const reporter = spyReporter();
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "a" }, { query: "b" }],
      reporter,
      concurrency: 4,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    expect(summary.ok).toBe(2);
    expect(reporter.outcomes.every((o) => typeof o.output === "string")).toBe(true);
  });

  it("captures from the per-row store at --out-key instead of result.output", async () => {
    // The replay fn writes into the injected store; run() must read outKey from that store.
    const replay: ReplayFn = async (o) => {
      await (o.store as Store).set("title", `stored-${(o.trace.steps[0] as { input: { arg: string } }).input.arg}`);
      return { ok: true, steps: [], output: "IGNORED" };
    };
    const reporter = spyReporter();
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "a" }],
      reporter,
      concurrency: 1,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      outKey: "title",
      yes: true,
      replay,
    });
    expect(reporter.outcomes[0]!.output).toBe("stored-https://x/?q=a");
    expect(reporter.outcomes[0]!.output).not.toBe("IGNORED");
  });

  it("substitutes the row value into the trace before replaying", async () => {
    const seen: string[] = [];
    const replay: ReplayFn = async (o) => {
      seen.push((o.trace.steps[0] as { input: { arg: string } }).input.arg);
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "wireless mouse" }, { query: "keyboard" }],
      reporter,
      concurrency: 1,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    expect(seen).toContain("https://x/?q=wireless mouse");
    expect(seen).toContain("https://x/?q=keyboard");
  });
});

describe("run worker pool", () => {
  it("never exceeds the concurrency bound for fan-out rows", async () => {
    let active = 0;
    let peak = 0;
    const replay: ReplayFn = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    const rows = Array.from({ length: 12 }, (_, i) => ({ query: `q${i}` }));
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows,
      reporter,
      concurrency: 3,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    // Row 0 runs alone (warm-up), then 11 rows fan out at <=3 concurrent.
    expect(peak).toBeLessThanOrEqual(3);
    expect(reporter.outcomes.length).toBe(12);
  });

  it("runs row 0 alone first, THEN fans out the rest", async () => {
    const order: number[] = [];
    let concurrentDuringFanout = 0;
    let warmupDone = false;
    const replay: ReplayFn = async (o) => {
      const idx = Number((o.trace.steps[0] as { input: { arg: string } }).input.arg.split("=")[1]);
      order.push(idx);
      // While the warm-up row is running, nothing else may be running.
      if (!warmupDone) {
        concurrentDuringFanout++;
      }
      await new Promise((r) => setTimeout(r, 5));
      if (idx === 0) warmupDone = true;
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    const rows = Array.from({ length: 4 }, (_, i) => ({ query: String(i) }));
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows,
      reporter,
      concurrency: 4,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    // Row 0 is the first to start and only it was in flight during warm-up.
    expect(order[0]).toBe(0);
    expect(concurrentDuringFanout).toBe(1);
  });
});

describe("run warm-up heal vs fan-out drift isolation", () => {
  it("grafts a row-0 heal onto the shared template (keeping {{var}}) but a fan-out drift does NOT mutate it", async () => {
    // A trace whose first step is an act on a button; row 0 will "heal" it to a new target.
    const sharedTrace: Trace = {
      version: 1,
      task: "act {{query}}",
      model: "m",
      createdAt: "now",
      steps: [
        { tool: "act", op: "click", target: { role: "button", name: "Old", ordinal: 0 } },
        { tool: "nav", input: { action: "goto", arg: "https://x/?q={{query}}" } },
      ],
      params: [{ name: "query", example: "wireless mouse", required: true }],
    };
    const seenTraces = new Set<Trace>();
    const replay: ReplayFn = async (o) => {
      seenTraces.add(o.trace);
      const q = (o.trace.steps[1] as { input: { arg: string } }).input.arg;
      if (o.heal && q.endsWith("=0")) {
        // Real replayTrace heal rewrites the act TARGET in-place on the trace it received.
        (o.trace.steps[0] as { target: { role: string; name: string; ordinal: number } }).target = {
          role: "button",
          name: "New",
          ordinal: 0,
        };
        return { ok: true, steps: [] };
      }
      if (q.endsWith("=2")) {
        return { ok: false, steps: [], drift: { step: 0, reason: "element gone for row 2" } };
      }
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    const rows = Array.from({ length: 3 }, (_, i) => ({ query: String(i) }));
    const summary = await run({
      trace: sharedTrace,
      tracePath: join(tmp, "t.json"),
      settings,
      rows,
      reporter,
      concurrency: 2,
      outPath: join(tmp, "out.jsonl"),
      heal: true,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    // The shared template's act target was grafted from the heal...
    expect((sharedTrace.steps[0] as { target: { name: string } }).target.name).toBe("New");
    // ...and the {{query}} template was preserved (not overwritten with row 0's concrete value).
    expect((sharedTrace.steps[1] as { input: { arg: string } }).input.arg).toBe("https://x/?q={{query}}");
    // Row 2 drifts, spends one mid-run repair, and that repair makes no progress for it (the fake
    // only repairs row 0). The drift stays a per-row outcome, the batch continues, and the shared
    // trace keeps the row-0 graft — a failed repair never writes row 2's concrete values into it.
    expect(summary.healed).toBe(1);
    expect(summary.drift).toBe(1);
    expect(summary.ok).toBe(2);
    const drifted = reporter.outcomes.find((o) => o.index === 2)!;
    expect(drifted.ok).toBe(false);
    expect(drifted.drift).toMatchObject({ step: 0 });
    // Every replay got a distinct cloned trace: 3 rows + row 2's repair attempt.
    expect(seenTraces.size).toBe(4);
  });

  it("passes heal=true only to row 0 and heal=false to fan-out rows", async () => {
    const heals: boolean[] = [];
    const replay: ReplayFn = async (o) => {
      heals.push(o.heal);
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "a" }, { query: "b" }, { query: "c" }],
      reporter,
      concurrency: 4,
      outPath: join(tmp, "out.jsonl"),
      heal: true,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    expect(heals[0]).toBe(true); // warm-up row
    expect(heals.slice(1)).toEqual([false, false]); // fan-out rows
  });
});

// ── mid-run healing ──────────────────────────────────────────────────────────
//
// A trace whose act step targets "Old". The fake replay models a site that changes mid-batch:
// from `driftsFrom` onward, a strict (heal=false) replay drifts unless the trace it receives has
// already been repaired to "New". A heal=true replay repairs the clone in place — exactly what
// replayTrace's microRepair does — which run() then grafts onto the shared template.

/** A trace with an act step (the drift surface) plus a {{query}} nav (the graft must preserve it). */
function traceWithAct(): Trace {
  return {
    version: 1,
    task: "act then nav {{query}}",
    model: "m",
    createdAt: "now",
    steps: [
      { tool: "act", op: "click", target: { role: "button", name: "Old", ordinal: 0 } },
      { tool: "nav", input: { action: "goto", arg: "https://x/?q={{query}}" } },
    ],
    params: [{ name: "query", example: "wireless mouse", required: true }],
  };
}

/** The row index encoded in a cloned trace's substituted nav arg. */
function rowOf(trace: Trace): number {
  return Number((trace.steps[1] as { input: { arg: string } }).input.arg.split("=")[1]);
}

function actName(trace: Trace): string {
  return (trace.steps[0] as { target: { name: string } }).target.name;
}

/**
 * A replay fake for a site that changes at row `driftsFrom`: the "Old" button is gone from then on.
 * Like the real replayTrace, healing only kicks in ON drift — a heal=true replay of a trace that
 * still matches costs nothing. A repair rewrites the clone's target to "New" in place, which is
 * exactly what microRepair does and what run() grafts back onto the shared template.
 */
function shiftingSiteReplay(driftsFrom: number, log: { heals: number[]; strict: number[] }): ReplayFn {
  return async (o) => {
    const row = rowOf(o.trace);
    const stale = row >= driftsFrom && actName(o.trace) === "Old";
    if (!o.heal) log.strict.push(row);
    if (!stale) return { ok: true, steps: [], output: `ok-${row}` };
    if (!o.heal) {
      return { ok: false, steps: [], drift: { step: 0, reason: `"Old" not found on row ${row}` } };
    }
    log.heals.push(row);
    (o.trace.steps[0] as { target: { role: string; name: string; ordinal: number } }).target = {
      role: "button",
      name: "New",
      ordinal: 0,
    };
    return { ok: true, steps: [], output: `healed-${row}` };
  };
}

describe("run mid-run healing", () => {
  it("repairs the trace ONCE when the site changes mid-batch, and later rows reuse the fix", async () => {
    const log = { heals: [] as number[], strict: [] as number[] };
    const trace = traceWithAct();
    const reporter = spyReporter();
    const summary = await run({
      trace,
      tracePath: join(tmp, "t.json"),
      settings,
      rows: Array.from({ length: 20 }, (_, i) => ({ query: String(i) })),
      reporter,
      concurrency: 1, // sequential: rows 0-4 pass, row 5 drifts and heals, 6-19 reuse the repair
      outPath: join(tmp, "out.jsonl"),
      heal: true,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay: shiftingSiteReplay(5, log),
    });

    // Exactly one model repair for the whole batch, spent on the first row that drifted.
    expect(summary.healed).toBe(1);
    expect(log.heals).toEqual([5]);
    // Every row completed: 0-4 strictly, 5 via its heal, 6-19 against the repaired template.
    expect(summary.ok).toBe(20);
    expect(summary.drift).toBe(0);
    // Rows after the repair passed on their FIRST strict attempt (no per-row retry storm).
    expect(log.strict.filter((r) => r > 5)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    // The repair reached the shared template, and the {{query}} template survived the graft.
    expect(actName(trace)).toBe("New");
    expect((trace.steps[1] as { input: { arg: string } }).input.arg).toBe("https://x/?q={{query}}");
  });

  it("holds a single heal lock: parallel workers that drift together retry instead of each healing", async () => {
    const log = { heals: [] as number[], strict: [] as number[] };
    const base = shiftingSiteReplay(1, log); // every fan-out row drifts until the trace is repaired
    // Slow every call so all 4 workers are in flight (and drifting) before the first heal lands.
    const replay: ReplayFn = async (o) => {
      await new Promise((r) => setTimeout(r, 10));
      return base(o);
    };
    const trace = traceWithAct();
    const reporter = spyReporter();
    const summary = await run({
      trace,
      tracePath: join(tmp, "t.json"),
      settings,
      rows: Array.from({ length: 12 }, (_, i) => ({ query: String(i) })),
      reporter,
      concurrency: 4,
      outPath: join(tmp, "out.jsonl"),
      heal: true,
      failFast: false,
      timeoutMs: 2000,
      resume: false,
      yes: true,
      replay,
    });

    // Row 0 (warm-up) still matches, so nothing heals there. The 4 workers that drift concurrently
    // produce exactly ONE repair, not one each — the losers wait on the lock and retry against it.
    expect(summary.healed).toBe(1);
    expect(log.heals.length).toBe(1);
    expect(summary.ok).toBe(12);
    expect(summary.drift).toBe(0);
  });

  it("retries for free when a repair landed while this row was replaying (does NOT spend a 2nd heal)", async () => {
    // Regression: a row that starts before a repair and drifts AFTER it lands must notice the newer
    // template and retry, not claim its own heal. The heal lock is already released by then, so
    // waiting on the lock alone is not enough — this is the gap the live 4-worker run exposed.
    const log = { heals: [] as number[], strict: [] as number[] };
    const base = shiftingSiteReplay(1, log);
    const replay: ReplayFn = async (o) => {
      const row = rowOf(o.trace);
      // Row 2's strict attempt is slow: it is still in flight while row 1 drifts, heals, and
      // releases the lock, so row 2 finds a repaired template and a FREE lock.
      if (row === 2 && !o.heal && actName(o.trace) === "Old") await new Promise((r) => setTimeout(r, 60));
      return base(o);
    };
    const trace = traceWithAct();
    const reporter = spyReporter();
    const summary = await run({
      trace,
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "0" }, { query: "1" }, { query: "2" }],
      reporter,
      concurrency: 2,
      outPath: join(tmp, "out.jsonl"),
      heal: true,
      failFast: false,
      timeoutMs: 2000,
      resume: false,
      yes: true,
      replay,
    });

    expect(summary.healed).toBe(1); // row 1 repaired; row 2 reused it instead of healing again
    expect(log.heals).toEqual([1]);
    expect(summary.ok).toBe(3);
    expect(actName(trace)).toBe("New");
  });

  it("stops at --max-heals and reports the remaining rows as drift instead of burning the budget", async () => {
    // A site that is genuinely broken: a heal never makes the target match, so every row drifts.
    let heals = 0;
    const replay: ReplayFn = async (o) => {
      if (o.heal) {
        heals++;
        return { ok: false, steps: [], drift: { step: 0, reason: "repair made no progress" } };
      }
      return { ok: false, steps: [], drift: { step: 0, reason: "gone" } };
    };
    const warnings: string[] = [];
    const reporter = spyReporter();
    reporter.warn = (m) => warnings.push(m);
    const summary = await run({
      trace: traceWithAct(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: Array.from({ length: 10 }, (_, i) => ({ query: String(i) })),
      reporter,
      concurrency: 2,
      outPath: join(tmp, "out.jsonl"),
      heal: true,
      maxHeals: 2,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });

    expect(summary.healed).toBe(2); // budget respected, not one heal per drifted row
    expect(heals).toBe(3); // 2 mid-run repairs + the warm-up row's own heal
    expect(summary.drift).toBe(10); // every row still reported, batch never hung
    expect(warnings.some((w) => /heal budget spent \(2\)/.test(w))).toBe(true);
  });

  it("never heals mid-run without --heal: drifted rows are reported as before", async () => {
    const log = { heals: [] as number[], strict: [] as number[] };
    const trace = traceWithAct();
    const reporter = spyReporter();
    const summary = await run({
      trace,
      tracePath: join(tmp, "t.json"),
      settings,
      rows: Array.from({ length: 6 }, (_, i) => ({ query: String(i) })),
      reporter,
      concurrency: 1,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay: shiftingSiteReplay(3, log),
    });

    expect(summary.healed).toBe(0);
    expect(log.heals).toEqual([]);
    expect(summary.drift).toBe(3); // rows 3,4,5
    expect(summary.ok).toBe(3);
    expect(actName(trace)).toBe("Old"); // the shared template was never touched
  });
});

describe("run resume", () => {
  it("skips rows already present in the out file (by index)", async () => {
    const outPath = join(tmp, "out.jsonl");
    // Pre-seed the out file as if indices 0 and 1 already completed.
    writeFileSync(
      outPath,
      JSON.stringify({ index: 0, input: { query: "a" }, ok: true, ms: 1 }) +
        "\n" +
        JSON.stringify({ index: 1, input: { query: "b" }, ok: true, ms: 1 }) +
        "\n",
      "utf8",
    );
    const ranIndices: number[] = [];
    const replay: ReplayFn = async () => {
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    reporter.onRowStart = (e) => ranIndices.push(e.index);
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "a" }, { query: "b" }, { query: "c" }],
      reporter,
      concurrency: 4,
      outPath,
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: true,
      yes: true,
      replay,
    });
    expect(ranIndices).toEqual([2]); // only the not-yet-completed row ran
    expect(summary.skipped).toBe(2);
    expect(summary.ran).toBe(1);
  });

  it("resumes by a stable --key column", async () => {
    const outPath = join(tmp, "out.jsonl");
    writeFileSync(
      outPath,
      JSON.stringify({ index: 99, input: { id: "x1", query: "a" }, ok: true, ms: 1 }) + "\n",
      "utf8",
    );
    const ranKeys: string[] = [];
    const replay: ReplayFn = async (o) => {
      ranKeys.push((o.trace.steps[0] as { input: { arg: string } }).input.arg);
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [
        { id: "x1", query: "a" }, // same id as the completed row -> skipped
        { id: "x2", query: "b" },
      ],
      reporter,
      concurrency: 1,
      outPath,
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: true,
      key: "id",
      yes: true,
      replay,
    });
    expect(ranKeys).toEqual(["https://x/?q=b"]);
  });
});

describe("run fail-fast vs collect-all", () => {
  it("collect-all (default) runs every row even when some error", async () => {
    const replay: ReplayFn = async (o) => {
      const q = (o.trace.steps[0] as { input: { arg: string } }).input.arg;
      if (q.endsWith("=1")) throw new Error("boom");
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: Array.from({ length: 4 }, (_, i) => ({ query: String(i) })),
      reporter,
      concurrency: 1,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    expect(summary.error).toBe(1);
    expect(summary.ran).toBe(4);
    expect(summary.aborted).toBe(false);
  });

  it("fail-fast aborts the batch on the first error", async () => {
    let started = 0;
    const replay: ReplayFn = async (o) => {
      started++;
      const q = (o.trace.steps[0] as { input: { arg: string } }).input.arg;
      // Make the warm-up row (index 0) succeed; the first fan-out row errors.
      if (q.endsWith("=1")) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: Array.from({ length: 10 }, (_, i) => ({ query: String(i) })),
      reporter,
      concurrency: 1,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: true,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    expect(summary.aborted).toBe(true);
    expect(summary.error).toBe(1);
    // With concurrency 1 and fail-fast, no rows should start after the erroring one.
    expect(started).toBeLessThan(10);
  });
});

describe("run output streaming + timeout + watch", () => {
  it("streams one JSON line per completed row to the out file", async () => {
    const outPath = join(tmp, "out.jsonl");
    const replay: ReplayFn = async () => ({ ok: true, steps: [], output: 42 });
    const reporter = spyReporter();
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "a" }, { query: "b" }],
      reporter,
      concurrency: 1,
      outPath,
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    const lines = readFileSync(outPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const parsed = lines.map((l) => JSON.parse(l) as RowOutcome);
    expect(parsed.every((o) => o.ok && o.output === 42)).toBe(true);
  });

  it("records a timeout as a per-row error and continues", async () => {
    const replay: ReplayFn = async (o) => {
      const q = (o.trace.steps[0] as { input: { arg: string } }).input.arg;
      if (q.endsWith("=1")) await new Promise((r) => setTimeout(r, 200)); // exceeds timeout
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "0" }, { query: "1" }, { query: "2" }],
      reporter,
      concurrency: 1,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 50,
      resume: false,
      yes: true,
      replay,
    });
    expect(summary.error).toBe(1);
    expect(summary.ok).toBe(2);
    const timedOut = reporter.outcomes.find((o) => o.index === 1)!;
    expect(timedOut.error).toMatch(/timeout/);
  });

  it("copies the profile per worker when settings.profileDir is set", async () => {
    const copies: number[] = [];
    const replay: ReplayFn = async (o) => {
      // each row gets the copied profile path, not the original
      expect(o.settings.profileDir).toMatch(/copied-w/);
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings: { ...settings, profileDir: "/orig/profile" },
      rows: [{ query: "a" }, { query: "b" }],
      reporter,
      concurrency: 2,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
      copyProfile: (src, worker) => {
        copies.push(worker);
        return `/tmp/copied-w${worker}`;
      },
    });
    expect(copies.length).toBe(2); // one copy per worker (warm-up worker 0 + one fan-out worker)
  });

  it("aborts the row signal on timeout so replay can tear down its Chrome", async () => {
    let abortedOnTimeout = false;
    const replay: ReplayFn = async (o) => {
      const q = (o.trace.steps[0] as { input: { arg: string } }).input.arg;
      if (q.endsWith("=1")) {
        // Simulate a hung replay that only resolves when its signal aborts.
        await new Promise<void>((resolve) => {
          o.signal?.addEventListener("abort", () => {
            abortedOnTimeout = true;
            resolve();
          });
        });
      }
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "0" }, { query: "1" }],
      reporter,
      concurrency: 1,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 30,
      resume: false,
      yes: true,
      replay,
    });
    expect(abortedOnTimeout).toBe(true); // the per-row controller really fired on timeout
    expect(summary.error).toBe(1);
  });

  it("falls back to concurrency 1 (and warns) when the profile copy fails", async () => {
    const warnings: string[] = [];
    const reporter = spyReporter();
    reporter.warn = (m) => warnings.push(m);
    const seenProfiles = new Set<string | undefined>();
    let active = 0;
    let peak = 0;
    const replay: ReplayFn = async (o) => {
      seenProfiles.add(o.settings.profileDir);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { ok: true, steps: [] };
    };
    const rows = Array.from({ length: 4 }, (_, i) => ({ query: `q${i}` }));
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings: { ...settings, profileDir: "/orig/profile" },
      rows,
      reporter,
      concurrency: 4,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
      copyProfile: () => {
        throw new Error("EBUSY: profile locked");
      },
    });
    expect(warnings.length).toBe(1);
    expect(peak).toBe(1); // forced to a single sequential Chrome
    expect(seenProfiles.has("/orig/profile")).toBe(true); // ran against the ORIGINAL profile
    expect(summary.ok).toBe(4); // every row still ran (graceful degradation, not all-errors)
  });

  it("reflects a parent-signal (SIGINT) abort in summary.aborted", async () => {
    const ac = new AbortController();
    const replay: ReplayFn = async () => {
      ac.abort(); // simulate a Ctrl-C arriving during the warm-up row
      return { ok: true, steps: [] };
    };
    const reporter = spyReporter();
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "a" }, { query: "b" }, { query: "c" }],
      reporter,
      concurrency: 2,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
      signal: ac.signal,
    });
    expect(summary.aborted).toBe(true); // CLI maps this (with ac.signal.aborted) to exit 130
    expect(summary.ran).toBeLessThan(3); // the fan-out was stopped
  });

  it("truncates a stale out file on a fresh (non-resume) run", async () => {
    const outPath = join(tmp, "out.jsonl");
    writeFileSync(outPath, JSON.stringify({ index: 99, input: {}, ok: true, ms: 1 }) + "\n", "utf8");
    const replay: ReplayFn = async () => ({ ok: true, steps: [] });
    const reporter = spyReporter();
    await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "a" }, { query: "b" }],
      reporter,
      concurrency: 1,
      outPath,
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: true,
      replay,
    });
    const lines = readFileSync(outPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2); // only THIS run's rows; the stale index-99 line is gone
    expect(lines.some((l) => l.includes('"index":99'))).toBe(false);
  });
});

describe("run confirm prompt", () => {
  it("aborts the fan-out when confirm returns false (only row 0 ran)", async () => {
    const replay: ReplayFn = async () => ({ ok: true, steps: [] });
    const reporter = spyReporter();
    const summary = await run({
      trace: traceWithEval(),
      tracePath: join(tmp, "t.json"),
      settings,
      rows: [{ query: "a" }, { query: "b" }, { query: "c" }],
      reporter,
      concurrency: 4,
      outPath: join(tmp, "out.jsonl"),
      heal: false,
      failFast: false,
      timeoutMs: 1000,
      resume: false,
      yes: false,
      confirm: async () => false,
      replay,
    });
    expect(summary.ran).toBe(1); // only the warm-up row
    expect(reporter.outcomes.length).toBe(1);
  });
});
