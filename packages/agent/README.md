<div align="center">

# pixelpi

**A browser that fits in your agent's context budget.**

*Six tools, 1,196 tokens of definitions. Playwright MCP charges 24 and 5,953 — on every call.*

[![npm version](https://img.shields.io/npm/v/pixelpi.svg)](https://www.npmjs.com/package/pixelpi)
[![npm downloads](https://img.shields.io/npm/dm/pixelpi.svg)](https://www.npmjs.com/package/pixelpi)
[![CI](https://github.com/josharsh/pixelpi/actions/workflows/ci.yml/badge.svg)](https://github.com/josharsh/pixelpi/actions/workflows/ci.yml)
[![license MIT](https://img.shields.io/npm/l/pixelpi.svg)](https://github.com/josharsh/pixelpi/blob/main/LICENSE)

```bash
npm i -g pixelpi
```

<img src="https://cdn.jsdelivr.net/gh/josharsh/pixelpi@main/assets/pixelpi.gif" alt="pixelpi running a recorded task across a dataset in parallel" width="760" />

</div>

Hand an agent a browser and the tool usually costs more context than the job does. Playwright MCP puts 24 tool definitions in front of the model — 5,953 tokens — before it has looked at a single page, then another 7,000 to 13,000 for the page itself. That's rent on a toolbox the agent mostly never opens.

pixelpi does the same work on a budget: **six tools, 1,196 tokens of definitions, and 2,100–4,900 tokens for an entire page**. Every number on this page came out of a script in [`bench/`](bench/) that you can run yourself, without an API key, and which will cheerfully tell you if I'm wrong.

It's a browser for agents that have other things to do with their context window. Drop it into Claude Code or Cursor as an MCP server, or drive it from the CLI.

## What you get

- **Six primitives instead of a toolbox.** `look · act · fill · nav · eval · store`. Anything more specific, the agent writes for itself at runtime as a skill — and only that skill's one-line description ever reaches the prompt.
- **5.0× less fixed context.** 1,196 tokens of tool definitions against Playwright MCP's 5,953. This is the one that compounds: you pay it on *every* call, not once at startup.
- **3.3× less per page**, across six real sites, counting the whole page with every element still addressable. [The numbers, and what they don't prove →](bench/)
- **Guardrails in the harness, not the prompt.** A domain fence, a dry-run/confirm gate in front of anything irreversible, token budgets, and a fail-closed `BLOCKED` outcome. A system prompt is a suggestion; a tool that refuses is a guarantee.
- **Record once, replay for free.** When a task finally works, save it as a trace and run it again with no model in the loop — across a CSV, in parallel, healing itself when the page shifts under you.
- **An MCP server in one line of config.** `npx -y pixelpi@latest mcp`, and your existing Claude Code or Cursor subscription drives it. No key to set up.
- **Meant to be driven by other software.** Typed SDK, and a `--json` contract clean enough for another agent to parse without heroics.

> Context is the scarce resource in an agent loop. Every token your browser tool spends describing itself is a token the agent doesn't get for the actual work.

## Quickstart

```bash
npm i -g pixelpi
pixelpi auth                                        # set provider + key (any model)
pixelpi "find the top story on Hacker News"         # run a task live
pixelpi "search Hacker News for rust" --record hn   # record it, then name the input
pixelpi run hn --over queries.csv --concurrency 8   # run it across a dataset, in parallel
```

You only need a key for the live model loop. Reproducing the token numbers and replaying a saved trace both work without one, and any provider will do.

## Use it as an MCP server

One line of config, and your agent's browser costs 1,196 tokens of definitions instead of 5,953. No API key — it runs on whatever model your client already pays for.

```json
{
  "mcpServers": {
    "pixelpi": { "command": "npx", "args": ["-y", "pixelpi@latest", "mcp"] }
  }
}
```

That's `~/.claude.json` for Claude Code, or Cursor's `mcp.json`. Chrome starts on the first tool call, not at startup, so an idle server costs you nothing but a few MB of Node.

The `@latest` is load-bearing: `npx` will happily run an old `pixelpi` you already installed globally instead of fetching a current one, and anything before 0.6.0 has no `mcp` subcommand — it'll read "mcp" as a task and try to go do it. Pinning the version skips that entirely.

The guardrails and the profile come along:

```json
{
  "mcpServers": {
    "pixelpi": {
      "command": "npx",
      "args": ["-y", "pixelpi@latest", "mcp", "--allow-domains", "github.com", "--dry-run", "--profile"]
    }
  }
}
```

`--profile` reuses the session you saved with `pixelpi login`, so the agent starts already signed in. `--allow-domains` fences it. `--dry-run` lets it fill anything and submit nothing. With `--confirm` there's no TTY to ask at, so consequential actions are refused and the reason is handed back to the model, which can decide and retry.

Want to check the 5× before you install it? `pnpm bench:tokens` prints both sides.

## The context budget, measured

Measured against [Playwright MCP](https://playwright.dev/mcp/introduction), because that's what people actually weigh this against. Both hand the model an accessibility tree with stable refs, so it's a fair fight over the same thing: what ends up in the context window. Run it yourself with `pnpm bench:tokens`.

**Fixed cost — tool definitions, serialized into the prompt on every call:**

| harness | tools | tokens |
|---|---:|---:|
| **pixelpi** | 6 | **1,196** |
| Playwright MCP | 24 | 5,953 |

**Per-page cost — the whole page, every element still addressable:**

| Site | pixelpi | Playwright MCP | ratio |
|---|---:|---:|---:|
| HackerNews | 3,972 | 12,452 | **3.13×** |
| ArXiv | 4,887 | 13,275 | **2.72×** |
| GitHub | 2,512 | 7,344 | **2.92×** |
| Coursera | 3,195 | 10,702 | **3.35×** |
| HuggingFace | 2,767 | 9,328 | **3.37×** |
| Apple | 2,144 | 9,597 | **4.48×** |

Mean **3.33×**, measured 2026-08-11 with `o200k_base` against `@playwright/mcp@0.0.79`.

That pixelpi column is deliberately unflattering: it charges for the *entire* page, paging included. In practice one `look()` renders the first 200 refs and that's all most steps ever need — on Hacker News that's 2,652 tokens against 12,452. I report the worse number because it's the honest one. [Full method →](bench/)

## Why it's different

| | pixelpi | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|
| Tools in context | **6** | 24 | 31 |
| Tool-definition tokens | **1,196** | 5,953 | not measured |
| Page representation | a11y tree, flat refs | a11y tree, nested YAML | mixed |
| Whole-page cost (HN) | **3,972** | 12,452 | not measured |
| Ships as an MCP server | yes | yes | yes |
| Substrate | **raw CDP** (no Playwright) | Playwright | CDP |
| Self-extension | agent writes JS skills at runtime | no | no |
| Replay | record once, replay with **0 tokens** | no | no |
| Parallel fan-out | record once, run a dataset for ~0 tokens/row | no | no |

To be clear about what this table is and isn't: the advantage is context, not capability. Playwright MCP's 24 tools genuinely do things these six don't. The bet is simply that an agent carrying a browser plus five other MCP servers runs out of context long before it runs out of features.

## Use it for

Giving your own agent a browser that doesn't eat its context window — especially an agent already weighed down by other MCP servers. Then, once a task works: bulk form submissions, scraping at scale, price and stock and account checks across a list, nightly portal exports. All of it replayed from a trace, with no model in the loop.

## Record, replay, and run over data

Solve it once with the model, save the trace, then never pay for that thinking again. The first run is the compiler. Every run after it is the binary.

```bash
pixelpi "find the top story on Hacker News" --record hn-top   # solve once, save a trace
pixelpi replay hn-top                                         # rerun it, no model, 0 tokens
pixelpi replay hn-top --heal                                  # repair one step if the page drifted
```

Traces key on each element's accessibility role and name, never CSS selectors or coordinates, which is why they survive most redesigns. A bare name lands in `~/.pixelpi/traces/`; pass a path (or a name ending in `.json`) to keep the trace in a repo next to the code that uses it. Strict `replay` needs no API key and exits `3` on drift, naming the step that stopped matching. `--heal` re-derives just that one step and rewrites the trace, so it corrects itself over time. Worth being clear-eyed here: replay reproduces actions, not intent. It shines on stable, repeated flows and nowhere else.

A parametrized trace is a function. Record it once with an example input, then map it over a list:

```bash
pixelpi "search Hacker News for rust" --record hn   # then name "rust" as the input q
pixelpi run hn --query rust                            # one input
pixelpi run hn --over queries.csv --concurrency 8      # map over a CSV/JSONL, in parallel
pixelpi run hn --over queries.csv --heal               # repair the trace if the site changes mid-run
```

Every row gets its own headless Chrome, bounded by `--concurrency` (default 4). Outcomes stream to a JSONL file via `--out`, and `--resume` picks up where a killed run left off.

Sites change halfway through a batch — that's just life. Under `--heal` the first row runs alone as a warm-up, and when a later row drifts (an A/B test renames a button, a cookie banner shows up at row 900) one worker repairs the shared trace and every other row reuses the fix, including the rows that already drifted while waiting. `--max-heals` (default 3) caps it: past that, drifted rows get reported instead of repaired, because a site that keeps changing is broken and shouldn't cost you one model run per row. A 5,000-row job comes out to one model run plus a handful of repairs.

## Describe a trace (for humans and agents)

Every trace is an introspectable function. `describe` shows what goes in and what comes out:

```bash
pixelpi describe hn            # human card: task, inputs, output, usage
pixelpi describe hn --json     # {"type":"description","params":[...],"output":{...}}
```

Under `--json` every command emits a single NDJSON stream — progress, results, and errors as `{"type":"error","code":...}` — so an agent driving pixelpi has exactly one contract to parse.

## Sessions and login

Runs get a fresh, disposable Chrome profile by default. When you need to stay logged in, use a persistent one:

```bash
pixelpi login https://github.com                    # sign in once, press Enter to save
pixelpi --profile "check my GitHub notifications"   # reuse the saved session, headless
```

`--profile` uses `~/.pixelpi/profile`, or `--profile=<dir>` for somewhere else. pixelpi finds Chrome on its own across macOS, Linux, and Windows; set `PIXELPI_CHROME=/path/to/chrome` if it guesses wrong.

## Guardrails

An agent that fills in forms and clicks Submit needs harder limits than a paragraph of English. Everything below is **deterministic and enforced at the tool layer**, where the model's judgment isn't a factor:

```bash
pixelpi --allow-domains sessionize.com "submit my talk at https://sessionize.com/..."  # can't wander off
pixelpi --dry-run "fill the order form on example.com and submit it"                   # stops at the commit boundary
pixelpi --confirm "send the contact form on example.com"                               # asks y/N before it commits
pixelpi --max-tokens 500000 "compare prices across 40 product pages"                   # hard token budget
```

- **`--allow-domains a.com,b.com`** — a navigation fence. `goto`/`newtab` off the list get refused, and off-fence link clicks or JS redirects bounce back to a blank page. The agent can't slip out to a search engine to "find an alternative".
- **`--dry-run`** — navigate, read, and fill as normal, but withhold the consequential click (submit, send, pay, publish, …). You get a report of exactly what *would* have been committed, and nothing is.
- **`--confirm`** — same detection, but it stops and asks y/N. With no TTY, or under `--json`, the action is denied and a `{"type":"pending_action",…}` event goes out so the calling agent can decide and re-run.
- **`--max-tokens <n>`** — a hard input+output budget that warns at 80% and then stops cleanly, mirroring `--max-steps`. Context is bounded by default too: stale page snapshots get elided from the conversation, so cost grows linearly with steps instead of quadratically.
- **Fail closed, and say so.** If the target is unreachable, the form data was never provided, or the door is simply shut, the agent stops with `BLOCKED: <reason>` and exit code 4 rather than quietly substituting a different goal or inventing values for fields.

## The six primitives

```
look · act · fill · nav · eval · store
```

- **`look(mode?, filter?, offset?)`** — a compact, ref-indexed accessibility snapshot. The `read`. Renders 200 refs at a time; `filter` searches the whole page and `offset` walks through it, so nothing on a big page is out of reach.
- **`act(ref, op, value?)`** — mutate the page by stable ref, through trusted CDP input events. The `write`.
- **`fill(fields[])`** — a whole form in one call.
- **`nav(action, arg?)`** — navigation, tabs, `waitfor`.
- **`eval(fn, args?, opts?)`** — arbitrary JS in the page realm. The escape hatch; the `bash` of the browser.
- **`store(action, key?, value?)`** — durable host-side JSON KV. The filesystem.

Elements are addressed by **stable ref** rather than CSS or coordinates: cheap, deterministic, and largely indifferent to layout churn. Everything else composes out of `eval` — the agent builds its own higher-level tools as JSON skills while it works, and the prompt only ever sees the one-line description of each.

## Use it from code

Load a saved trace as a callable function. No model, no API key:

```ts
import { loadTrace } from "pixelpi";

const hn = loadTrace("hn");                          // by name (home library) or path
console.log(hn.describe());                          // { params, output, ... }
const r  = await hn({ query: "rust" });              // run once  -> { ok, output }
const rs = await hn.over(rows, { concurrency: 4 });  // map over a dataset, results in input order
```

You can also drive the full agent loop, or take the six primitives straight to raw CDP with no model at all. See [`examples/`](https://github.com/josharsh/pixelpi/tree/main/examples).

## Philosophy

The model is the harness now. So you expose the substrate's irreducible primitives and let the agent compose everything else on top.

Every tool you add is rent, paid on every call, forever. That reframes the design question: not "what would be useful to have?" but "what is the smallest set that spans the space?" Six, it turns out, with `eval` as the escape hatch — and anything more specific becomes a skill the agent writes for itself when it needs one. This is the bet pi made for the terminal, pointed at the browser instead.

[docs/how-it-works.md](https://github.com/josharsh/pixelpi/blob/main/docs/how-it-works.md) has the moving parts: why six tools, and why raw CDP rather than Playwright.

## Status

The substrate (`look`/`eval`) is exercised live against real sites, and the MCP server is driven end-to-end as a real subprocess. The agent loop, guards, stores, replay, run, MCP protocol, and provider adapters are unit-tested — 265 tests, mock provider, no network. The full model-to-browser loop needs an API key; the MCP path doesn't.

Needs Node >= 20 and Google Chrome, which remains the one dependency you can't `npm install`. macOS, Linux, and Windows.

Pre-1.0. Things move.

## Contributing

Issues and PRs welcome. Run `pnpm install && pnpm build && pnpm test` before you open one. See [CONTRIBUTING.md](https://github.com/josharsh/pixelpi/blob/main/CONTRIBUTING.md).

## License

MIT © 2026 Harsh Joshi
