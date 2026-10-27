/**
 * Success-rate pilot — needs ANTHROPIC_API_KEY (reads .env). Spends real money.
 * Small, auto-judged suite on bot-accessible sites with INDEPENDENT ground truth,
 * so pass/fail is real, not vibes. Reports success, steps, tokens, $/task.
 *
 * Run: node --import tsx bench/tasks.ts
 */
import { createBrowserAgentSession } from "pixelpi";
import { MemoryStore, type AgentStopReason } from "@josharsh/pixelpi-core";
import { writeFileSync } from "node:fs";
import { scoreTask, summarizeTasks, type TaskStatus } from "./task-scoring";

try {
  process.loadEnvFile();
} catch {
  /* key may be in the real env */
}

const IN_PER_M = 3,
  OUT_PER_M = 15; // Sonnet-class list price (estimate)

interface Task {
  id: string;
  task: string;
  truth: () => Promise<string[]>; // answer must contain one of these
}

const tasks: Task[] = [
  {
    id: "example.com heading",
    task: "Go to https://example.com and tell me the exact text of the main heading.",
    truth: async () => ["Example Domain"],
  },
  {
    id: "HN #1 title",
    task: "Go to https://news.ycombinator.com and tell me the exact title of the #1 (top) story.",
    truth: async () => {
      const ids = (await (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")).json()) as number[];
      const item = (await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${ids[0]}.json`)).json()) as { title: string };
      return [item.title];
    },
  },
  {
    id: "Wikipedia: Eiffel Tower completed",
    task: "Go to the Wikipedia page for the Eiffel Tower and tell me the year its construction was completed.",
    truth: async () => ["1889"],
  },
  {
    id: "Wikipedia: Apollo 11 year",
    task: "Go to the Wikipedia page for Apollo 11 and tell me the year of the Moon landing.",
    truth: async () => ["1969"],
  },
  {
    id: "GitHub: cli/cli latest release",
    task: "Go to https://github.com/cli/cli/releases and tell me the version tag of the latest release.",
    truth: async () => {
      const r = (await (await fetch("https://api.github.com/repos/cli/cli/releases/latest", {
        headers: { "User-Agent": "pixelpi-bench" },
      })).json()) as { tag_name: string };
      return [r.tag_name, r.tag_name.replace(/^v/, "")];
    },
  },
];

async function main() {
  const startedAt = new Date().toISOString();
  const model = process.env.PIXELPI_MODEL || "claude-sonnet-4-6";
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex < 0 ? undefined : process.argv[outIndex + 1];
  if (outIndex >= 0 && (!out || out.startsWith("--"))) throw new Error("--out requires a JSON file path");
  const rows: Array<{ id: string; status: TaskStatus; stopReason?: AgentStopReason; steps: number;
    inTok: number; outTok: number; ms: number; truth: string[]; answer: string; err: string }> = [];
  let totIn = 0,
    totOut = 0;
  let fatalError = "";
  for (const t of tasks) {
    if (fatalError) {
      rows.push({ id: t.id, status: "not_run", steps: 0, inTok: 0, outTok: 0, ms: 0, truth: [], answer: "", err: fatalError });
      continue;
    }
    let truth: string[];
    try {
      truth = await t.truth();
      if (!truth.length || truth.some((value) => !value?.trim())) throw new Error("Empty ground truth");
    } catch (e) {
      rows.push({ id: t.id, status: "unscored", steps: 0, inTok: 0, outTok: 0, ms: 0, truth: [], answer: "", err: String(e) });
      continue;
    }
    const t0 = Date.now();
    let session: Awaited<ReturnType<typeof createBrowserAgentSession>> | undefined;
    let stopReason: AgentStopReason = "error";
    let answer = "",
      steps = 0,
      inTok = 0,
      outTok = 0,
      err = "";
    try {
      session = await createBrowserAgentSession({ task: t.task, launch: { headless: true }, maxSteps: 14, maxTotalTokens: 100000, store: new MemoryStore() });
      const res = await session.run();
      stopReason = res.stopReason;
      answer = res.finalText || "";
      steps = res.steps;
      inTok = res.usage.inputTokens;
      outTok = res.usage.outputTokens;
      if (stopReason === "error" || stopReason === "aborted") err = answer;
    } catch (e) {
      err = (e as Error).message;
    } finally {
      await session?.close();
    }
    const status = scoreTask(stopReason, answer, truth);
    totIn += inTok;
    totOut += outTok;
    rows.push({ id: t.id, status, stopReason, steps, inTok, outTok, ms: Date.now() - t0, truth, answer, err });
    process.stderr.write(`${status.toUpperCase()}  ${t.id}  (${steps} steps, ${inTok}+${outTok} tok)${err ? ` ${err}` : ""}\n`);
    if (err && /API key|HTTP (401|403|404|429)/i.test(err)) fatalError = err;
  }

  const summary = summarizeTasks(rows);
  console.log("\n| Task | result | steps | in tok | out tok | answer (truncated) |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows)
    console.log(`| ${r.id} | ${r.status} | ${r.steps} | ${r.inTok} | ${r.outTok} | ${(r.err || r.answer).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 120)} |`);

  const cost = model === "claude-sonnet-4-6" ? (totIn / 1e6) * IN_PER_M + (totOut / 1e6) * OUT_PER_M : null;
  console.log(
    `\nSuccess: ${summary.successRate === null ? "N/A — incomplete or invalid run" : `${summary.passed}/${summary.total} (${Math.round(100 * summary.successRate)}%)`} · ` +
      `${summary.evaluated}/${summary.total} tasks evaluated · ` +
      `total ${totIn} in / ${totOut} out tokens · ` +
      (summary.successRate !== null && cost !== null ? `≈ $${cost.toFixed(3)} total, $${(cost / rows.length).toFixed(3)}/task ` : "No completed-suite cost estimate. ") +
      `Model: ${model}. This five-task retrieval pilot is NOT Pomerado's enterprise benchmark.`,
  );
  if (out) writeFileSync(out, JSON.stringify({ startedAt, model, suite: "pixelpi-five-retrieval-task-pilot", summary,
    usage: { inputTokens: totIn, outputTokens: totOut }, estimatedObservedTokenCostUsd: cost, rows }, null, 2) + "\n");
  if (summary.successRate === null) process.exitCode = 2;
  else if (summary.passed !== summary.total) process.exitCode = 1;
}

main().catch((e) => {
  console.error("pilot failed:", e);
  process.exit(1);
});
