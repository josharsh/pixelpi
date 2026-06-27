import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrace } from "./sdk";
import type { ReplayFn, RunOptions, RunSummary } from "./run";
import type { Trace } from "./trace";

const TRACE: Trace = {
  version: 1,
  task: "echo {q}",
  model: "m",
  createdAt: "now",
  params: [{ name: "q", example: "x", required: true }],
  steps: [
    { tool: "nav", input: { action: "goto", arg: "https://x" } },
    { tool: "eval", input: { fn: "return args[0]", args: ["{{q}}"] } },
  ],
};

/** Pull the (substituted) first eval arg out of a trace, to prove substitution happened. */
function evalArg(t: Trace): unknown {
  const s = t.steps.find((x) => x.tool === "eval");
  return s && s.tool === "eval" ? s.input.args?.[0] : undefined;
}

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pixelpi-sdk-"));
  path = join(dir, "echo.trace.json");
  writeFileSync(path, JSON.stringify(TRACE), "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadTrace as a callable", () => {
  it("substitutes the row's vars into the trace and returns ok + output", async () => {
    const replay: ReplayFn = async (opts) => ({ ok: true, steps: [], output: evalArg(opts.trace) });
    const fn = loadTrace(path, { replay });
    const r = await fn({ q: "rust" });
    expect(r).toEqual({ ok: true, output: "rust", drift: undefined });
    expect(fn.params.map((p) => p.name)).toEqual(["q"]);
    expect(fn.trace.task).toBe("echo {q}");
  });

  it("exposes the trace signature via .describe()", () => {
    const d = loadTrace(path).describe();
    expect(d.params.map((p) => p.name)).toEqual(["q"]);
    expect(d.steps).toBe(2);
    expect(d.output).toEqual({ from: "eval", step: 1 });
  });

  it("coerces non-string vars to strings before substitution", async () => {
    let seen: unknown;
    const replay: ReplayFn = async (opts) => {
      seen = evalArg(opts.trace);
      return { ok: true, steps: [], output: seen };
    };
    await loadTrace(path, { replay })({ q: 42 });
    expect(seen).toBe("42");
  });

  it("passes drift through from a strict replay", async () => {
    const replay: ReplayFn = async () => ({ ok: false, steps: [], drift: { step: 1, reason: "gone" } });
    const r = await loadTrace(path, { replay })({ q: "x" });
    expect(r.ok).toBe(false);
    expect(r.drift).toEqual({ step: 1, reason: "gone" });
  });

  it(".over maps the trace across rows and collects every outcome in order", async () => {
    const fakeRun = async (opts: RunOptions): Promise<RunSummary> => {
      opts.rows.forEach((row, index) =>
        opts.reporter.onRowDone({
          worker: 0,
          outcome: { index, input: row, ok: true, output: row.q, ms: 1 },
        }),
      );
      return {
        total: opts.rows.length,
        ran: opts.rows.length,
        skipped: 0,
        ok: opts.rows.length,
        drift: 0,
        error: 0,
        ms: 1,
        aborted: false,
        outPath: "",
      };
    };
    const fn = loadTrace(path, { run: fakeRun });
    const rows = await fn.over([{ q: "a" }, { q: "b" }, { q: "c" }], { concurrency: 2 });
    expect(rows.map((o) => o.output)).toEqual(["a", "b", "c"]);
  });

  it(".over returns results in INPUT order even when rows finish out of order", async () => {
    // Emit outcomes out of order (index 2, then 0, then 1); .over must sort back to input order.
    const outOfOrder = async (opts: RunOptions): Promise<RunSummary> => {
      for (const index of [2, 0, 1]) {
        opts.reporter.onRowDone({
          worker: 0,
          outcome: { index, input: opts.rows[index]!, ok: true, output: opts.rows[index]!.q, ms: 1 },
        });
      }
      return { total: 3, ran: 3, skipped: 0, ok: 3, drift: 0, error: 0, ms: 1, aborted: false, outPath: "" };
    };
    const fn = loadTrace(path, { run: outOfOrder });
    const rows = await fn.over([{ q: "a" }, { q: "b" }, { q: "c" }]);
    expect(rows.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(rows.map((o) => o.output)).toEqual(["a", "b", "c"]);
  });

  it("throws a clear error when the trace file is missing", () => {
    expect(() => loadTrace(join(dir, "nope.trace.json"))).toThrow(/not found/);
  });
});
