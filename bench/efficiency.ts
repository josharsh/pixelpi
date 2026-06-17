/**
 * Deterministic efficiency benchmark — no LLM, no key.
 * For each WebVoyager site: how many tokens does pixelpi's look() cost the model,
 * vs a naive raw-DOM dump? This generalizes the "107x" claim to the benchmark's real sites.
 *
 * Run: node --import tsx bench/efficiency.ts
 */
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import { MemoryStore, type Tool, type ToolContext } from "@josharsh/pixelpi-core";

const SITES: [string, string][] = [
  ["Allrecipes", "https://www.allrecipes.com"],
  ["Amazon", "https://www.amazon.com"],
  ["Apple", "https://www.apple.com"],
  ["ArXiv", "https://arxiv.org"],
  ["GitHub", "https://github.com"],
  ["ESPN", "https://www.espn.com"],
  ["Coursera", "https://www.coursera.org"],
  ["Cambridge", "https://dictionary.cambridge.org"],
  ["BBC", "https://www.bbc.com/news"],
  ["HuggingFace", "https://huggingface.co"],
  ["Wolfram", "https://www.wolframalpha.com"],
  ["Booking", "https://www.booking.com"],
];

const ctx: ToolContext = { signal: new AbortController().signal, emit: () => {} };
const tok = (n: number) => Math.ceil(n / 4); // ~4 chars/token

async function measure(url: string) {
  const { session, close } = await launchChrome({ headless: true, startUrl: url });
  try {
    const tools = createBrowserTools({ session, store: new MemoryStore() });
    const look = tools.find((t: Tool) => t.name === "look")!;
    const evalT = tools.find((t: Tool) => t.name === "eval")!;
    await new Promise((r) => setTimeout(r, 1800)); // let SPAs render
    const looked = await look.execute({}, ctx);
    const lookTokens = tok(looked.content.length);
    let rawTokens = 0;
    try {
      const raw = await evalT.execute({ fn: "return document.documentElement.outerHTML.length" }, ctx);
      rawTokens = tok(Number(JSON.parse(raw.content)) || 0);
    } catch {
      /* leave 0 */
    }
    return { lookTokens, rawTokens };
  } finally {
    await close();
  }
}

async function main() {
  const rows: { site: string; look: number; raw: number; factor: number; note: string }[] = [];
  for (const [name, url] of SITES) {
    process.stderr.write(`measuring ${name}… `);
    try {
      const { lookTokens, rawTokens } = await measure(url);
      const note = lookTokens < 80 ? "blocked/blank (bot wall)" : "";
      rows.push({
        site: name,
        look: lookTokens,
        raw: rawTokens,
        factor: rawTokens && lookTokens ? +(rawTokens / lookTokens).toFixed(1) : 0,
        note,
      });
      process.stderr.write(`look=${lookTokens} raw=${rawTokens}${note ? " (" + note + ")" : ""}\n`);
    } catch (e) {
      rows.push({ site: name, look: 0, raw: 0, factor: 0, note: "error: " + (e as Error).message.slice(0, 40) });
      process.stderr.write("ERROR\n");
    }
  }

  console.log("\n| Site | look() tok | raw DOM tok | factor | note |");
  console.log("|---|---|---|---|---|");
  for (const r of rows)
    console.log(`| ${r.site} | ${r.look} | ${r.raw} | ${r.factor ? r.factor + "×" : "—"} | ${r.note} |`);

  const usable = rows.filter((r) => r.factor > 0 && !r.note);
  if (usable.length) {
    const avg = usable.reduce((s, r) => s + r.factor, 0) / usable.length;
    const med = usable.map((r) => r.factor).sort((a, b) => a - b)[Math.floor(usable.length / 2)];
    const avgLook = Math.round(usable.reduce((s, r) => s + r.look, 0) / usable.length);
    console.log(
      `\nUsable sites: ${usable.length}/${rows.length}. ` +
        `Mean factor ${avg.toFixed(1)}× · median ${med}× · avg look() ${avgLook} tokens. ` +
        `(Blocked/blank sites excluded — they need the vision/auth fallback.)`,
    );
  }
}

main().catch((e) => {
  console.error("bench failed:", e);
  process.exit(1);
});
