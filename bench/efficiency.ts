/**
 * Deterministic context-cost benchmark — no LLM, no API key.
 *
 * The question this answers: to let a model act on a page, how many tokens does it
 * cost you? Measured against Playwright MCP, which is the tool people actually
 * compare pixelpi to — not a raw-DOM dump, which nobody ships to a model.
 *
 * Two costs matter, and the fixed one is usually the bigger one:
 *   1. Tool definitions — paid on EVERY call, before the agent sees anything
 *   2. Page representation — paid per look
 *
 * Run: pnpm bench:tokens        (add --no-mcp to skip the Playwright MCP baseline)
 */
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import { MemoryStore, type Tool, type ToolContext } from "@josharsh/pixelpi-core";
import { getEncoding } from "js-tiktoken";
import { McpClient } from "./mcp-client";

const SITES: [string, string][] = [
  ["HackerNews", "https://news.ycombinator.com"],
  ["ArXiv", "https://arxiv.org"],
  ["GitHub", "https://github.com"],
  ["Coursera", "https://www.coursera.org"],
  ["HuggingFace", "https://huggingface.co"],
  ["Apple", "https://www.apple.com"],
];

const enc = getEncoding("o200k_base");
const tok = (s: string) => enc.encode(s).length;
const ctx: ToolContext = { signal: new AbortController().signal, emit: () => {} };
const withMcp = !process.argv.includes("--no-mcp");

interface Row {
  site: string;
  ppTokens: number;
  ppCalls: number;
  ppRefs: number;
  mcpTokens: number;
  note: string;
}

/** Page through look() until the whole page has been rendered; sum what the model would pay. */
async function measurePixelpi(url: string): Promise<{ tokens: number; calls: number; refs: number }> {
  const { session, close } = await launchChrome({ headless: true, startUrl: url });
  try {
    const tools = createBrowserTools({ session, store: new MemoryStore() });
    const look = tools.find((t: Tool) => t.name === "look")!;
    await new Promise((r) => setTimeout(r, 2500));

    let tokens = 0;
    let calls = 0;
    let refs = 0;
    let offset = 0;
    for (;;) {
      const r = await look.execute(offset ? { offset } : {}, ctx);
      tokens += tok(r.content);
      calls++;
      const total = r.content.match(/^(\d+) refs/m);
      if (total) refs = Number(total[1]);
      const more = r.content.match(/offset=(\d+)/);
      if (!more || calls > 20) break;
      offset = Number(more[1]);
    }

    return { tokens, calls, refs };
  } finally {
    await close();
  }
}

async function main() {
  let mcp: McpClient | undefined;
  let mcpToolTokens = 0;
  let mcpToolCount = 0;

  if (withMcp) {
    process.stderr.write("starting @playwright/mcp… ");
    try {
      mcp = new McpClient("npx", ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chrome", "--isolated"]);
      await mcp.initialize();
      const defs = await mcp.listTools();
      mcpToolCount = defs.length;
      mcpToolTokens = tok(JSON.stringify(defs, null, 2));
      process.stderr.write(`ok (${mcpToolCount} tools)\n`);
    } catch (e) {
      process.stderr.write(`unavailable: ${(e as Error).message.slice(0, 80)}\n`);
      mcp?.close();
      mcp = undefined;
    }
  }

  // Fixed cost: tool definitions, paid on every single call.
  const ppTools = createBrowserTools({
    session: { on: () => {}, off: () => {}, send: async () => ({}) } as never,
    store: new MemoryStore(),
  });
  const ppToolTokens = tok(
    JSON.stringify(
      ppTools.map((t: Tool) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      null,
      2,
    ),
  );

  const rows: Row[] = [];
  for (const [site, url] of SITES) {
    process.stderr.write(`measuring ${site}… `);
    const row: Row = { site, ppTokens: 0, ppCalls: 0, ppRefs: 0, mcpTokens: 0, note: "" };
    try {
      const p = await measurePixelpi(url);
      row.ppTokens = p.tokens;
      row.ppCalls = p.calls;
      row.ppRefs = p.refs;
      if (p.refs < 20) row.note = "blocked/blank (bot wall)";
    } catch (e) {
      row.note = "pixelpi error: " + (e as Error).message.slice(0, 40);
    }
    if (mcp && !row.note) {
      try {
        await mcp.callText("browser_navigate", { url });
        row.mcpTokens = tok(await mcp.callText("browser_snapshot", {}));
      } catch (e) {
        row.note = "mcp error: " + (e as Error).message.slice(0, 40);
      }
    }
    rows.push(row);
    process.stderr.write(`pixelpi=${row.ppTokens} mcp=${row.mcpTokens || "—"}${row.note ? " " + row.note : ""}\n`);
  }
  mcp?.close();

  console.log("\n## Fixed cost — tool definitions, paid on every call\n");
  console.log("| harness | tools | tokens |");
  console.log("|---|---:|---:|");
  console.log(`| **pixelpi** | ${ppTools.length} | **${ppToolTokens.toLocaleString("en-US")}** |`);
  if (mcpToolCount) {
    console.log(`| Playwright MCP | ${mcpToolCount} | ${mcpToolTokens.toLocaleString("en-US")} |`);
    console.log(`\n**${(mcpToolTokens / ppToolTokens).toFixed(1)}× less context before the agent looks at anything.**`);
  }

  console.log("\n## Per-page cost — the whole page, every element addressable\n");
  console.log("| Site | pixelpi | calls | refs | Playwright MCP | ratio |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const ratio = r.mcpTokens && r.ppTokens ? `**${(r.mcpTokens / r.ppTokens).toFixed(2)}×**` : "—";
    console.log(
      `| ${r.site} | ${r.ppTokens.toLocaleString("en-US")} | ${r.ppCalls} | ${r.ppRefs} | ` +
        `${r.mcpTokens ? r.mcpTokens.toLocaleString("en-US") : "—"} | ${ratio} |`,
    );
  }

  const usable = rows.filter((r) => !r.note && r.mcpTokens && r.ppTokens);
  if (usable.length) {
    const mean = usable.reduce((s, r) => s + r.mcpTokens / r.ppTokens, 0) / usable.length;
    console.log(
      `\n${usable.length}/${rows.length} sites comparable. Mean per-page advantage **${mean.toFixed(2)}×**. ` +
        `Tokens counted with o200k_base, not a chars/4 estimate. ` +
        `pixelpi figures are the FULL page — every ref reachable, paging included.`,
    );
  }
  if (rows.some((r) => r.note)) {
    console.log(`\nExcluded: ${rows.filter((r) => r.note).map((r) => `${r.site} (${r.note})`).join(", ")}.`);
  }
}

main().catch((e) => {
  console.error("bench failed:", e);
  process.exit(1);
});
