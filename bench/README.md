# bench

**3.3× less context than Playwright MCP per page, and 5× less before the agent looks at anything.** Both numbers come from `efficiency.ts`, which you can run yourself with no API key. `tasks.ts` is a separate check that the lean view still completes real tasks.

## Why the baseline is Playwright MCP, not raw DOM

An earlier version of this benchmark compared `look()` against a raw `document.documentElement.outerHTML` dump and reported factors of 37× to 100×. That comparison was misleading and it has been removed. Nobody ships raw DOM to a model — [Playwright MCP](https://playwright.dev/mcp/snapshots) returns an accessibility-tree snapshot with `[ref=eNN]` handles, which is the same *category* of representation as `look()`. Measuring against raw HTML was measuring against a strawman, and it made the real advantage look like marketing.

Against the tool people actually use, the honest number is **~3.3× per page** and **5× on tool definitions**. Smaller, verifiable, and it holds up when someone re-runs it.

## Context cost (`efficiency.ts`)

Two costs matter, and the fixed one is usually the one that hurts:

1. **Tool definitions** — serialized into the prompt on *every* call, before the agent has seen a single page
2. **Page representation** — paid per `look()`

```bash
pnpm install && pnpm build
pnpm bench:tokens              # add --no-mcp to skip the Playwright MCP baseline
```

Tokens counted with `o200k_base` via `js-tiktoken` — not a `chars/4` estimate, which understates real token counts by roughly 25%.

Measured 2026-08-11, headless Chrome, `@playwright/mcp@0.0.79`:

### Fixed cost — tool definitions, paid on every call

| harness | tools | tokens |
|---|---:|---:|
| **pixelpi** | 6 | **1,196** |
| Playwright MCP | 24 | 5,953 |

**5.0× less context before the agent looks at anything.** This is the number that compounds: it is paid on every step of every loop, and it is the budget that isn't available for the agent's actual job.

### Per-page cost — the whole page, every element addressable

| Site | pixelpi | calls | refs | Playwright MCP | ratio |
|---|---:|---:|---:|---:|---:|
| HackerNews | 3,972 | 2 | 351 | 12,452 | **3.13×** |
| ArXiv | 4,887 | 3 | 447 | 13,275 | **2.72×** |
| GitHub | 2,512 | 1 | 182 | 7,344 | **2.92×** |
| Coursera | 3,195 | 2 | 227 | 10,702 | **3.35×** |
| HuggingFace | 2,767 | 2 | 224 | 9,328 | **3.37×** |
| Apple | 2,144 | 1 | 121 | 9,597 | **4.48×** |

Mean **3.33×** across six sites.

The pixelpi column is the cost of the **entire page** — paging included, every ref addressable. That matters, because the comparison would flatter pixelpi otherwise: a single `look()` renders the first 200 refs, so on Hacker News one call costs 2,652 tokens against Playwright MCP's 12,452, which reads as 4.7×. Charging pixelpi for all 351 refs across both calls is the fair comparison, and it gives 3.13×.

Most real steps only need the first page — the agent looks, finds its target in the first 200 refs, and acts. So 3.33× is the conservative floor, not the typical case.

### What we don't claim

- This measures **context cost**, not capability. Playwright MCP's 24 tools do things pixelpi's 6 do not.
- Roughly a third of the per-page gap is representation format: Playwright MCP emits nested YAML and carries a `/url:` line for every link — about 3,400 tokens on Hacker News — which pixelpi omits entirely. Strip those and the gap narrows to roughly 3.4× on HN rather than 5×.
- Bot-walled sites (Amazon, Booking, ESPN, Allrecipes, Cambridge) serve a near-empty page to headless Chrome. They're excluded rather than counted as wins; a blank page is cheap and useless.

## Tasks (`tasks.ts`)

Five retrieval tasks on accessible sites, checked against ground truth pulled from public APIs (HN, GitHub) and stable facts. Needs `ANTHROPIC_API_KEY`; costs a few cents.

```bash
pnpm bench:tasks
```

Measured 2026-06-17, `claude-sonnet-4-6`:

| Task | result | steps | tokens |
|---|---|---|---|
| example.com heading | ✅ | 2 | 4.2k |
| HN #1 story title | ✅ | 2 | 7.2k |
| Wikipedia: Eiffel Tower year | ✅ | 2 | 8.3k |
| Wikipedia: Apollo 11 year | ✅ | 2 | 7.3k |
| GitHub: cli/cli latest release | ✅ | 2 | 6.9k |

5/5, about 2¢ a task. These are easy single-page lookups, not multi-step flows. It shows the cost holds up on simple tasks, nothing more.
