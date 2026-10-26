/**
 * No-key diagnostic of real Chrome replay output/error behavior.
 * Hand-authored traces and a local fixture, NOT Pomerado's benchmark or an agent solve.
 * Run: pnpm exec tsx bench/replay-probe.ts [--out results.json]
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { MemoryStore } from "@josharsh/pixelpi-core";
import { replayTrace, type Trace, type ReplayResult, type ResolvedSettings } from "pixelpi";

const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end('<!doctype html><title>Replay diagnostic</title><h1 id="current">Current value</h1>');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing fixture address");
const url = `http://127.0.0.1:${address.port}/`;
const settings: ResolvedSettings = {
  provider: "anthropic", model: "unused-no-model", headless: true,
  storePath: ".unused-replay-probe-store.json", keySource: "none", envVar: "ANTHROPIC_API_KEY",
};
const trace = (fn?: string): Trace => ({
  version: 1, task: "Read the current heading", model: "hand-authored-no-model",
  createdAt: new Date().toISOString(), result: { finalText: "Old value from recording" },
  steps: [
    { tool: "nav", input: { action: "goto", arg: url } },
    ...(fn ? [{ tool: "eval" as const, input: { fn } }] : []),
  ],
});
const cases: { id: string; trace: Trace; check: (r: ReplayResult) => boolean; expectation: string }[] = [
  { id: "fresh-extraction", trace: trace('return document.querySelector("h1").textContent'),
    check: (r) => r.ok && r.output === "Current value", expectation: "Fresh output matches independently known fixture heading" },
  { id: "missing-selector", trace: trace('const el = document.querySelector("#removed"); if (!el) throw new Error("Required heading missing"); return el.textContent;'),
    check: (r) => !r.ok, expectation: "Replay reports failure when the extraction tool errors" },
  { id: "nav-only-freshness", trace: trace(),
    check: (r) => r.output === "Current value", expectation: "A retrieval result must contain fresh data, not recorded finalText; nav-only traces cannot satisfy this" },
];
const rows = [];
try {
  for (const c of cases) {
    const start = performance.now();
    const result = await replayTrace({ trace: c.trace, settings, tracePath: "unused.json", store: new MemoryStore(), heal: false });
    const row = { id: c.id, expectation: c.expectation, passed: c.check(result), ms: performance.now() - start, modelCalls: 0, result };
    rows.push(row);
    console.error(`${row.passed ? "PASS" : "FAIL"} ${c.id}: reported ok=${result.ok}, ${row.ms.toFixed(0)}ms`);
  }
} finally {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
const report = { recordedAt: new Date().toISOString(), suite: "local-hand-authored-replay-diagnostic", rows };
const json = JSON.stringify(report, null, 2) + "\n";
const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0) {
  const path = process.argv[outIndex + 1];
  if (!path || path.startsWith("--")) throw new Error("--out requires a path");
  writeFileSync(path, json);
} else console.log(json);
if (rows.some((row) => !row.passed)) process.exitCode = 1;
