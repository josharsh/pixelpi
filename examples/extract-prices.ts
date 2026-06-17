/**
 * Structured extraction with a live event stream. The agent decides how to read
 * the page; pixelpi just gives it the primitives. Watch it work via onEvent.
 *
 * Run:  ANTHROPIC_API_KEY=sk-... pnpm dlx tsx examples/extract-prices.ts
 */
import { createBrowserAgentSession } from "pixelpi";

const session = await createBrowserAgentSession({
  task: "Go to https://news.ycombinator.com and return the top 5 story titles as a JSON array.",
  launch: { headless: true },
  onEvent: (e) => {
    if (e.type === "tool_start") console.log(`→ ${e.name}`, JSON.stringify(e.input).slice(0, 80));
  },
});

try {
  const result = await session.run();
  console.log("\nResult:\n" + result.finalText);
  console.log(`\n(${result.steps} steps · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out)`);
} finally {
  await session.close();
}
