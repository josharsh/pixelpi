/**
 * The 20-second demo, as code. Drives a real browser to read Hacker News.
 *
 * Run:  ANTHROPIC_API_KEY=sk-... pnpm dlx tsx examples/hn-top-story.ts
 */
import { createBrowserAgentSession } from "pixelpi";

const session = await createBrowserAgentSession({
  task: "go to news.ycombinator.com and tell me the title of the top story",
  launch: { headless: true },
});

try {
  const result = await session.run();
  console.log(result.finalText);
} finally {
  await session.close();
}
