<div align="center">

# pixelpi

**A minimal browser-agent harness. Six tools, raw CDP, any model.**

*The page is the prompt.*

[![npm version](https://img.shields.io/npm/v/pixelpi.svg)](https://www.npmjs.com/package/pixelpi)
[![npm downloads](https://img.shields.io/npm/dm/pixelpi.svg)](https://www.npmjs.com/package/pixelpi)
[![CI](https://github.com/josharsh/pixelpi/actions/workflows/ci.yml/badge.svg)](https://github.com/josharsh/pixelpi/actions/workflows/ci.yml)
[![license MIT](https://img.shields.io/npm/l/pixelpi.svg)](https://github.com/josharsh/pixelpi/blob/main/LICENSE)

```bash
npm i -g pixelpi
```

<img src="https://raw.githubusercontent.com/josharsh/pixelpi/main/assets/pixelpi.gif" alt="pixelpi driving a real browser from the terminal" width="760" />

</div>

> `pixelpi "find the top story on Hacker News"`: the agent opens a real Chrome, looks once, and reports the title in a few steps. No Playwright, no vision model, no cloud.

Every other browser agent buries the model under a 20–30-tool MCP surface and a raw-DOM firehose. pixelpi gives it **six primitives** and a bounded view of the page. A heavy page that costs ~180k tokens as raw DOM, pixelpi hands the model in ~2k. That's **37× to 100× fewer tokens** across real sites, and it stays flat as the page grows. The model already knows how to use a browser; pixelpi just gets out of the way.

If pixelpi saves you a 30-tool MCP install, a star helps others find it.

## Install

```bash
npm i -g pixelpi   # the CLI
pixelpi            # first run → guided setup, then an interactive chat
```

## Quickstart

```bash
npm i -g pixelpi                          # 1. install the global binary
pixelpi auth                              # 2. set provider + key (or: export ANTHROPIC_API_KEY=…)
pixelpi "find the top story on Hacker News and store its title"   # 3. run a task
```

First run with no config drops you into guided setup (provider · key · model), then an interactive browser-agent chat. `pixelpi --json "…"` emits NDJSON for scripts.

## Sessions and login

Every run uses a fresh, disposable Chrome profile by default (logged out). To stay logged in across runs, use a persistent profile:

```bash
pixelpi login https://github.com          # opens a real Chrome; sign in, press Enter to save
pixelpi --profile "check my GitHub notifications"   # reuses the saved session, headless
```

- `--profile` uses `~/.pixelpi/profile`; `--profile=<dir>` uses a custom one (handy for separate accounts).
- Omit `--profile` for a fresh disposable profile each run.
- Chrome locks a profile dir, so don't run two tasks against the same profile at once.

pixelpi finds Chrome automatically on macOS, Linux, and Windows. Set `PIXELPI_CHROME=/path/to/chrome` to override.

## Record and replay

Save a solved run as a trace and replay it later with no model in the loop. The first run is the compile step; every replay is the binary: free, deterministic, and fast.

```bash
pixelpi "find the top story on Hacker News" --record hn-top   # solve once, save a trace
pixelpi replay hn-top                                         # rerun it with no model, 0 tokens
pixelpi replay hn-top --heal                                  # repair one step with the model if the page drifted
```

- Traces key on the accessibility role and name of each element, not CSS selectors or coordinates, so they survive most layout churn. A bare name lives in `~/.pixelpi/traces/`; pass a path (or a name ending in `.json`) to keep a trace inside a repo.
- `--record` writes only when the run completes. Omit the name and it auto-slugs the task.
- Strict `replay` needs no API key. On drift it stops and exits `3`, naming the step that no longer matches. `--heal` re-derives just that step with the model and rewrites the trace, so it self-corrects over time.

Replay reproduces actions, not intent: it is for stable, repeated flows (a login, an export, a scrape). `--heal` is what reintroduces judgment when a page has genuinely changed.

## The six primitives

```
look · act · fill · nav · eval · store
```

- **`look(mode?, filter?)`**: compact, ref-indexed accessibility/DOM snapshot. The `read`.
- **`act(ref, op, value?)`**: mutate the page by stable ref via trusted CDP input events. The `write`/`edit`.
- **`fill(fields[])`**: batched form fill in one call.
- **`nav(action, arg?)`**: navigate, tabs, `waitfor`. The `cd` / processes.
- **`eval(fn, args?, opts?)`**: arbitrary JS in the page realm. The escape hatch, the `bash` of the browser.
- **`store(action, key?, value?)`**: durable host-side JSON KV. The filesystem.

Elements are addressed by **stable ref** (not CSS/coordinates): cheap, deterministic, resilient to layout churn. Everything else is composable from `eval`; the agent writes its own higher-level tools as JSON skills at runtime, and only each skill's one-line description enters the prompt.

## Why it's different

| | pixelpi | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|
| Tools in context | **6** | 21 | 31 |
| Tool-def + prompt tokens | **~1,055** | ~13,700 | ~18,000 |
| Page representation | a11y tree (bounded) | mixed | mixed |
| Substrate | **raw CDP** (no Playwright) | Playwright | CDP |
| Self-extension | agent writes JS skills at runtime | no | no |
| Replay | record once, replay with **0 tokens** | no | no |

**Token cost:** `look()` vs a raw-DOM dump, measured across the 15 sites [WebVoyager](https://github.com/MinorJerry/WebVoyager) tests on (full table + script in [`bench/`](https://github.com/josharsh/pixelpi/tree/main/bench)):

| Site | `look()` | raw DOM | factor |
|---|---|---|---|
| Coursera | 1,997 tok | 202,892 tok | **101.6×** |
| GitHub | 1,955 tok | 146,787 tok | **75.1×** |
| Apple | 2,254 tok | 96,507 tok | **42.8×** |
| Hugging Face | 1,932 tok | 45,300 tok | **23.4×** |
| ArXiv | 1,588 tok | 10,652 tok | **6.7×** |

**37× to 100× fewer tokens** across these sites (37× median). `look()` holds ~2k tokens whatever the page weighs, while the raw DOM keeps growing. Five of the twelve bot-block headless Chrome and return an empty page; [`bench/`](https://github.com/josharsh/pixelpi/tree/main/bench) has the full run. Reproduce it yourself: `pnpm bench:tokens`, no key needed.

## SDK usage

Drive the full agent loop from code:

```ts
import { createBrowserAgentSession } from "pixelpi";

const session = await createBrowserAgentSession({
  task: "extract all job listings from https://example.co/careers into JSON",
  launch: { headless: true },
});
try {
  const result = await session.run();
  console.log(result.finalText);
} finally {
  await session.close();
}
```

Or use the six primitives directly against raw CDP, no model in the loop:

```ts
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import { MemoryStore } from "@josharsh/pixelpi-core";

const { session, close } = await launchChrome({ headless: true, startUrl: "https://news.ycombinator.com" });
const [look, , , , evalJs] = createBrowserTools({ session, store: new MemoryStore() });
const ctx = { signal: new AbortController().signal, emit: () => {} };

console.log((await look.execute({}, ctx)).content);                 // compact a11y snapshot
console.log((await evalJs.execute({ fn: "return document.title" }, ctx)).content);
await close();
```

More in [`examples/`](https://github.com/josharsh/pixelpi/tree/main/examples).

## Philosophy

The model is the harness now, so you expose the substrate's irreducible primitives and let the agent compose the rest. See [docs/how-it-works.md](https://github.com/josharsh/pixelpi/blob/main/docs/how-it-works.md) for the moving parts (why six tools, why raw CDP, why no MCP).

## Contributing

Issues and PRs welcome. Run `pnpm install && pnpm build && pnpm test` before opening a PR. See [CONTRIBUTING.md](https://github.com/josharsh/pixelpi/blob/main/CONTRIBUTING.md).

## Status

Substrate (`look`/`eval`) is validated live against real sites. The agent loop, guards, stores, and provider adapters are unit-tested (119 tests, mock provider, no network in tests). The full LLM↔browser loop runs once you supply an API key. Requires Node ≥ 20 and Google Chrome (macOS, Linux, or Windows).

## License

MIT © 2026 Harsh Joshi
