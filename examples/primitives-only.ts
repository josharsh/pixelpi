/**
 * No LLM, no API key. Drive the primitives directly — this is the substrate the
 * agent sits on. Shows the two load-bearing tools: a bounded `look()` snapshot
 * and `eval()` as the escape hatch.
 *
 * Run:  pnpm dlx tsx examples/primitives-only.ts   (needs Google Chrome)
 */
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import { MemoryStore, type Tool, type ToolContext } from "@josharsh/pixelpi-core";

const ctx: ToolContext = { signal: new AbortController().signal, emit: () => {} };
const tool = (tools: Tool[], name: string) => tools.find((t) => t.name === name)!;

const { session, close } = await launchChrome({ headless: true, startUrl: "https://news.ycombinator.com" });
try {
  const tools = createBrowserTools({ session, store: new MemoryStore() });
  await new Promise((r) => setTimeout(r, 1200));

  // 1. look() — a compact, ref-indexed view of the page (hundreds of tokens, not thousands)
  const snapshot = await tool(tools, "look").execute({}, ctx);
  console.log("look():\n" + snapshot.content.slice(0, 600) + "\n");

  // 2. eval() — pull structured data out in one shot, the data never bloats the model's context
  const stories = await tool(tools, "eval").execute(
    {
      fn: `return [...document.querySelectorAll('.athing .titleline > a')]
             .slice(0, 5).map(a => ({ title: a.innerText, url: a.href }))`,
    },
    ctx,
  );
  console.log("eval() extracted:\n" + stories.content);
} finally {
  await close();
}
