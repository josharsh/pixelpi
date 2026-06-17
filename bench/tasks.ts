/**
 * Success-rate pilot — needs ANTHROPIC_API_KEY (reads .env). Spends real money.
 * Small, auto-judged suite on bot-accessible sites with INDEPENDENT ground truth,
 * so pass/fail is real, not vibes. Reports success, steps, tokens, $/task.
 *
 * Run: node --import tsx bench/tasks.ts
 */
import { createBrowserAgentSession } from "pixelpi";

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

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

async function main() {
  const rows: any[] = [];
  let totIn = 0,
    totOut = 0;
  for (const t of tasks) {
    const truth = await t.truth().catch(() => ["<truth fetch failed>"]);
    const t0 = Date.now();
    const session = await createBrowserAgentSession({ task: t.task, launch: { headless: true }, maxSteps: 14 });
    let answer = "",
      steps = 0,
      inTok = 0,
      outTok = 0,
      err = "";
    try {
      const res = await session.run();
      answer = res.finalText || "";
      steps = res.steps;
      inTok = res.usage.inputTokens;
      outTok = res.usage.outputTokens;
    } catch (e) {
      err = (e as Error).message.slice(0, 60);
    } finally {
      await session.close();
    }
    const pass = !err && truth.some((g) => norm(answer).includes(norm(g)));
    totIn += inTok;
    totOut += outTok;
    rows.push({ id: t.id, pass, steps, inTok, outTok, ms: Date.now() - t0, truth: truth[0], answer: answer.replace(/\s+/g, " ").slice(0, 90), err });
    process.stderr.write(`${pass ? "PASS" : "FAIL"}  ${t.id}  (${steps} steps, ${inTok}+${outTok} tok)\n`);
  }

  const passed = rows.filter((r) => r.pass).length;
  console.log("\n| Task | result | steps | in tok | out tok | answer (truncated) |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows)
    console.log(`| ${r.id} | ${r.pass ? "✅" : r.err ? "⚠️ " + r.err : "❌"} | ${r.steps} | ${r.inTok} | ${r.outTok} | ${r.answer} |`);

  const cost = (totIn / 1e6) * IN_PER_M + (totOut / 1e6) * OUT_PER_M;
  console.log(
    `\nSuccess: ${passed}/${rows.length} (${Math.round((100 * passed) / rows.length)}%) · ` +
      `total ${totIn} in / ${totOut} out tokens · ` +
      `≈ $${cost.toFixed(3)} total, $${(cost / rows.length).toFixed(3)}/task ` +
      `(est. at Sonnet $${IN_PER_M}/$${OUT_PER_M} per Mtok). Bot-accessible sites only.`,
  );
}

main().catch((e) => {
  console.error("pilot failed:", e);
  process.exit(1);
});
