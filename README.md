<div align="center">

# pixelpi

**A browser your AI can afford.**

*Record a task once. Run it on a thousand rows for the cost of one.*

[![npm version](https://img.shields.io/npm/v/pixelpi.svg)](https://www.npmjs.com/package/pixelpi)
[![npm downloads](https://img.shields.io/npm/dm/pixelpi.svg)](https://www.npmjs.com/package/pixelpi)
[![CI](https://github.com/josharsh/pixelpi/actions/workflows/ci.yml/badge.svg)](https://github.com/josharsh/pixelpi/actions/workflows/ci.yml)
[![license MIT](https://img.shields.io/npm/l/pixelpi.svg)](https://github.com/josharsh/pixelpi/blob/main/LICENSE)

```bash
npm i -g pixelpi
```

<img src="https://cdn.jsdelivr.net/gh/josharsh/pixelpi@main/assets/pixelpi.gif" alt="pixelpi running a recorded task across a dataset in parallel" width="760" />

</div>

pixelpi lets any AI model use a real web browser, and it reads each page in about 2,000 tokens instead of 180,000. Then it goes further: once a task works, you record it, and pixelpi repeats those exact steps with no model in the loop, across a whole dataset, in parallel, self-healing when a page changes. It is pi, the minimal coding agent, applied to the browser: six tools, raw Chrome DevTools Protocol, any model, your key.

## What you get

- Read any page in **~2,000 tokens**, 37x to 100x fewer than raw DOM.
- **Record** a solved task once; **replay** it with no model, deterministically, for free.
- **Run** a recorded task across a CSV or JSONL **in parallel**, about 0 tokens per row.
- **Self-heals**: when a page changes, the model fixes one step and every other row reuses it.
- **Callable from code, readable by other AI agents** (typed SDK plus a clean `--json` contract).
- **Guardrailed**: a domain fence, a dry-run/confirm gate before anything irreversible, token budgets, and a fail-closed `BLOCKED` outcome — enforced in the harness, not the prompt.

> A normal browser agent does 5,000 inputs as 5,000 full loops. pixelpi does one recorded run plus 4,999 free replays. The model thinks once; the rest is nearly free.

## Quickstart

```bash
npm i -g pixelpi
pixelpi auth                                        # set provider + key (any model)
pixelpi "find the top story on Hacker News"         # run a task live
pixelpi "search Hacker News for rust" --record hn   # record it, then name the input
pixelpi run hn --over queries.csv --concurrency 8   # run it across a dataset, in parallel
```

No key is needed to reproduce the token numbers or to replay a recorded trace. A key is only for the live model loop, and pixelpi works with any provider.

## The token win, measured

`look()` versus a raw-DOM dump, across the sites [WebVoyager](https://github.com/MinorJerry/WebVoyager) tests on. Full table and a reproducible script (no key needed) are in [`bench/`](https://github.com/josharsh/pixelpi/tree/main/bench):

| Site | `look()` | raw DOM | factor |
|---|---|---|---|
| Coursera | 1,997 tok | 202,892 tok | **101.6×** |
| GitHub | 1,955 tok | 146,787 tok | **75.1×** |
| Apple | 2,254 tok | 96,507 tok | **42.8×** |
| Hugging Face | 1,932 tok | 45,300 tok | **23.4×** |
| ArXiv | 1,588 tok | 10,652 tok | **6.7×** |

`look()` holds around 2k tokens whatever the page weighs, while the raw DOM keeps growing. The heavier the site, the bigger the win.

## Why it's different

| | pixelpi | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|
| Tools in context | **6** | 21 | 31 |
| Tool-def + prompt tokens | **~1,055** | ~13,700 | ~18,000 |
| Page representation | a11y tree (bounded) | mixed | mixed |
| Substrate | **raw CDP** (no Playwright) | Playwright | CDP |
| Self-extension | agent writes JS skills at runtime | no | no |
| Replay | record once, replay with **0 tokens** | no | no |
| Parallel fan-out | record once, run a dataset for ~0 tokens/row | no | no |

## Use it for

Bulk form submissions, scraping at scale, price, stock, or account checks across a list, nightly portal exports, or giving your own AI agent a browser tool it can afford and call.

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
pixelpi run hn --query rust                          # one input
pixelpi run hn --over queries.csv --concurrency 8    # map over a CSV/JSONL, in parallel
```

Each row runs in its own headless Chrome, bounded by `--concurrency` (default 4). Outcomes stream to a JSONL file (`--out`), `--resume` skips rows already done, and the first row runs alone as a warm-up so a single `--heal` repair benefits every other row. A 5,000-row job costs one model run plus, at most, a handful of repairs.

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

- **`look(mode?, filter?)`**: compact, ref-indexed accessibility snapshot. The `read`.
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

The model is the harness now, so you expose the substrate's irreducible primitives and let the agent compose the rest. This is the bet pi made for the terminal, applied to the browser. See [docs/how-it-works.md](https://github.com/josharsh/pixelpi/blob/main/docs/how-it-works.md) for the moving parts (why six tools, why raw CDP, why no MCP).

## Status

Substrate (`look`/`eval`) is validated live against real sites. The agent loop, guards, stores, replay, run, and provider adapters are unit-tested (239 tests, mock provider, no network in tests). The full model-to-browser loop runs once you supply an API key. Requires Node >= 20 and Google Chrome (macOS, Linux, or Windows). Pre-1.0 and moving fast.

## Contributing

Issues and PRs welcome. Run `pnpm install && pnpm build && pnpm test` before opening a PR. See [CONTRIBUTING.md](https://github.com/josharsh/pixelpi/blob/main/CONTRIBUTING.md).

## License

MIT © 2026 Harsh Joshi
