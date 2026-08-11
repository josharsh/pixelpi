<div align="center">

# pixelpi

**A browser that fits in your agent's context budget.**

*Six tools and 1,196 tokens of definitions — against Playwright MCP's 24 and 5,953, paid on every single call.*

[![npm version](https://img.shields.io/npm/v/pixelpi.svg)](https://www.npmjs.com/package/pixelpi)
[![npm downloads](https://img.shields.io/npm/dm/pixelpi.svg)](https://www.npmjs.com/package/pixelpi)
[![CI](https://github.com/josharsh/pixelpi/actions/workflows/ci.yml/badge.svg)](https://github.com/josharsh/pixelpi/actions/workflows/ci.yml)
[![license MIT](https://img.shields.io/npm/l/pixelpi.svg)](https://github.com/josharsh/pixelpi/blob/main/LICENSE)

```bash
npm i -g pixelpi
```

<img src="https://cdn.jsdelivr.net/gh/josharsh/pixelpi@main/assets/pixelpi.gif" alt="pixelpi running a recorded task across a dataset in parallel" width="760" />

</div>

Giving an agent a browser usually costs more context than the work it was hired to do. Playwright MCP spends 5,953 tokens on tool definitions before the agent has seen anything, then 7,000–13,000 more per page. pixelpi does the same job on a budget: **6 tools, 1,196 tokens of definitions, and 2,100–4,900 tokens for a whole page** — measured, on real sites, with a script you can run without an API key.

It's a browser tool for agents that have other work to do.

## What you get

- **5.0× less fixed context**: 6 tools at 1,196 tokens vs Playwright MCP's 24 at 5,953 — paid on *every* call, not once.
- **3.3× less per page**, averaged over six real sites, counting the full page and every element addressable. [See the numbers →](bench/)
- **Six primitives, not a toolbox**: `look · act · fill · nav · eval · store`. The agent composes the rest as runtime skills, and only a one-line description per skill enters the prompt.
- **Guardrailed at the tool layer**, not the prompt: a domain fence, a dry-run/confirm gate before anything irreversible, token budgets, and a fail-closed `BLOCKED` outcome.
- **Record and replay**: once a task works, save it as a trace and rerun it with no model in the loop — over a CSV, in parallel, self-healing when the page drifts.
- **Callable from code, readable by other agents**: typed SDK plus a clean `--json` contract.

> Context is the scarce resource in an agent loop. Every token a browser tool spends describing itself is a token your agent doesn't have for the task.

## Quickstart

```bash
npm i -g pixelpi
pixelpi auth                                        # set provider + key (any model)
pixelpi "find the top story on Hacker News"         # run a task live
pixelpi "search Hacker News for rust" --record hn   # record it, then name the input
pixelpi run hn --over queries.csv --concurrency 8   # run it across a dataset, in parallel
```

No key is needed to reproduce the token numbers or to replay a recorded trace. A key is only for the live model loop, and pixelpi works with any provider.

## The context budget, measured

Against [Playwright MCP](https://playwright.dev/mcp/introduction) — the tool people actually compare this to. Both return an accessibility tree with stable refs, so this is a like-for-like comparison of what lands in the model's context. Reproducible with `pnpm bench:tokens`, no API key:

**Fixed cost — tool definitions, serialized into the prompt on every call:**

| harness | tools | tokens |
|---|---:|---:|
| **pixelpi** | 6 | **1,196** |
| Playwright MCP | 24 | 5,953 |

**Per-page cost — the whole page, every element addressable:**

| Site | pixelpi | Playwright MCP | ratio |
|---|---:|---:|---:|
| HackerNews | 3,972 | 12,452 | **3.13×** |
| ArXiv | 4,887 | 13,275 | **2.72×** |
| GitHub | 2,512 | 7,344 | **2.92×** |
| Coursera | 3,195 | 10,702 | **3.35×** |
| HuggingFace | 2,767 | 9,328 | **3.37×** |
| Apple | 2,144 | 9,597 | **4.48×** |

Mean **3.33×**, measured 2026-08-11 with `o200k_base` against `@playwright/mcp@0.0.79`. The pixelpi column charges for the *entire* page including paging — a single `look()` renders the first 200 refs, which is what most steps actually need, and on Hacker News that's 2,652 tokens against 12,452. [Full method, and what we don't claim →](bench/)

## Why it's different

| | pixelpi | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|
| Tools in context | **6** | 24 | 31 |
| Tool-definition tokens | **1,196** | 5,953 | not measured |
| Page representation | a11y tree, flat refs | a11y tree, nested YAML | mixed |
| Whole-page cost (HN) | **3,972** | 12,452 | not measured |
| Substrate | **raw CDP** (no Playwright) | Playwright | CDP |
| Self-extension | agent writes JS skills at runtime | no | no |
| Replay | record once, replay with **0 tokens** | no | no |
| Parallel fan-out | record once, run a dataset for ~0 tokens/row | no | no |

pixelpi's advantage here is context, not capability — Playwright MCP's 24 tools do things these 6 don't. The bet is that an agent with a browser plus five other MCP servers runs out of context before it runs out of features.

## Use it for

Giving your own agent a browser tool that doesn't eat its context window — especially one already loaded with other MCP servers. Then, once a task works: bulk form submissions, scraping at scale, price/stock/account checks across a list, and nightly portal exports, all replayed from a recorded trace with no model in the loop.

## Record, replay, and run over data

Save a solved run as a trace, then replay it with no model in the loop. The first run is the compile step; every replay is the binary: free, deterministic, and fast.

```bash
pixelpi "find the top story on Hacker News" --record hn-top   # solve once, save a trace
pixelpi replay hn-top                                         # rerun it, no model, 0 tokens
pixelpi replay hn-top --heal                                  # repair one step if the page drifted
```

Traces key on the accessibility role and name of each element, not CSS selectors or coordinates, so they survive most layout changes. A bare name lives in `~/.pixelpi/traces/`; pass a path (or a name ending in `.json`) to keep a trace inside a repo. Strict `replay` needs no API key and exits `3` on drift, naming the step that no longer matches. `--heal` re-derives just that step with the model and rewrites the trace, so it self-corrects over time. Replay reproduces actions, not intent: it shines for stable, repeated flows.

A parametrized trace is a function. Record it once with an example input, then run it across a list:

```bash
pixelpi "search Hacker News for rust" --record hn   # then name "rust" as the input q
pixelpi run hn --query rust                            # one input
pixelpi run hn --over queries.csv --concurrency 8      # map over a CSV/JSONL, in parallel
pixelpi run hn --over queries.csv --heal               # repair the trace if the site changes mid-run
```

Each row runs in its own headless Chrome, bounded by `--concurrency` (default 4). Outcomes stream to a JSONL file (`--out`), and `--resume` skips rows already done.

Sites change mid-batch. Under `--heal`, the first row runs alone as a warm-up, and if a later row drifts — an A/B test renames a button, a banner appears at row 900 — one worker repairs the shared trace with the model and every other row reuses that fix, including the ones that already drifted waiting for it. `--max-heals` (default 3) caps the repairs: past it, drifted rows are reported rather than repaired, so a genuinely broken site can't cost one model run per row. A 5,000-row job costs one model run plus, at most, a handful of repairs.

## Describe a trace (for humans and agents)

Every trace is an introspectable function. `describe` shows its inputs and output:

```bash
pixelpi describe hn            # human card: task, inputs, output, usage
pixelpi describe hn --json     # {"type":"description","params":[...],"output":{...}}
```

Under `--json`, every command emits one NDJSON stream (progress, results, and errors as `{"type":"error","code":...}`), so an AI agent can drive pixelpi and parse a single clean contract.

## Sessions and login

Every run uses a fresh, disposable Chrome profile by default. To stay logged in across runs, use a persistent profile:

```bash
pixelpi login https://github.com                    # sign in once, press Enter to save
pixelpi --profile "check my GitHub notifications"   # reuse the saved session, headless
```

`--profile` uses `~/.pixelpi/profile`; `--profile=<dir>` uses a custom one. pixelpi finds Chrome automatically on macOS, Linux, and Windows; set `PIXELPI_CHROME=/path/to/chrome` to override.

## Guardrails

An agent that fills forms and clicks Submit needs harder limits than a system prompt. Every guardrail below is **deterministic — enforced at the tool layer**, not left to the model's judgment:

```bash
pixelpi --allow-domains sessionize.com "submit my talk at https://sessionize.com/..."  # can't wander off
pixelpi --dry-run "fill the order form on example.com and submit it"                   # stops at the commit boundary
pixelpi --confirm "send the contact form on example.com"                               # asks y/N before it commits
pixelpi --max-tokens 500000 "compare prices across 40 product pages"                   # hard token budget
```

- **`--allow-domains a.com,b.com`** — a navigation fence. `goto`/`newtab` off the list are refused, and off-fence link clicks or JS redirects bounce back to a blank page. The agent can't reach a search engine to "find an alternative".
- **`--dry-run`** — navigate, read, and fill normally, but a consequential click (submit, send, pay, publish, …) is withheld; the run reports exactly what *would* have been committed, and commits nothing.
- **`--confirm`** — same detection, but pauses for an explicit y/N. With no TTY (or under `--json`) the action is denied and a `{"type":"pending_action",…}` event is emitted, so a calling agent can decide and re-run.
- **`--max-tokens <n>`** — a total input+output budget that warns at 80% and stops cleanly, mirroring `--max-steps`. Context is also bounded by default — stale page snapshots are elided from the conversation, so cost grows linearly with steps, not quadratically.
- **Fail closed, first class.** If the target is unreachable, closed, or required form data was never provided, the agent stops with `BLOCKED: <reason>` (exit code 4) instead of substituting a different goal or inventing field values.

## The six primitives

```
look · act · fill · nav · eval · store
```

- **`look(mode?, filter?, offset?)`**: compact, ref-indexed accessibility snapshot. The `read`. Renders 200 refs at a time; `filter` searches the whole page and `offset` pages through it, so nothing on a large page is unreachable.
- **`act(ref, op, value?)`**: mutate the page by stable ref via trusted CDP input events. The `write`.
- **`fill(fields[])`**: batched form fill in one call.
- **`nav(action, arg?)`**: navigate, tabs, `waitfor`.
- **`eval(fn, args?, opts?)`**: arbitrary JS in the page realm. The escape hatch, the `bash` of the browser.
- **`store(action, key?, value?)`**: durable host-side JSON KV. The filesystem.

Elements are addressed by **stable ref**, not CSS or coordinates: cheap, deterministic, resilient to layout churn. Everything else composes from `eval`; the agent writes its own higher-level tools as JSON skills at runtime, and only each skill's one-line description enters the prompt.

## Use it from code

Load a saved trace as a callable function, no model or API key required:

```ts
import { loadTrace } from "pixelpi";

const hn = loadTrace("hn");                          // by name (home library) or path
console.log(hn.describe());                          // { params, output, ... }
const r  = await hn({ query: "rust" });              // run once  -> { ok, output }
const rs = await hn.over(rows, { concurrency: 4 });  // map over a dataset, results in input order
```

Or drive the full agent loop, or the six primitives against raw CDP with no model. More in [`examples/`](https://github.com/josharsh/pixelpi/tree/main/examples).

## Philosophy

The model is the harness now, so you expose the substrate's irreducible primitives and let the agent compose the rest. Every tool you add is rent the agent pays on every call, forever — so the right number of tools is the smallest set that spans the space, and everything else becomes a runtime skill the agent writes for itself. This is the bet pi made for the terminal, applied to the browser. See [docs/how-it-works.md](https://github.com/josharsh/pixelpi/blob/main/docs/how-it-works.md) for the moving parts: why six tools, and why raw CDP instead of Playwright.

## Status

Substrate (`look`/`eval`) is validated live against real sites. The agent loop, guards, stores, replay, run, and provider adapters are unit-tested (253 tests, mock provider, no network in tests). The full model-to-browser loop runs once you supply an API key. Requires Node >= 20 and Google Chrome (macOS, Linux, or Windows). Pre-1.0 and moving fast.

## Contributing

Issues and PRs welcome. Run `pnpm install && pnpm build && pnpm test` before opening a PR. See [CONTRIBUTING.md](https://github.com/josharsh/pixelpi/blob/main/CONTRIBUTING.md).

## License

MIT © 2026 Harsh Joshi
