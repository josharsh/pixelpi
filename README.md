<div align="center">

# pixelpi

**A minimal browser-agent harness — six tools, raw CDP, any model.**

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

> `pixelpi "find the top story on Hacker News"` — the agent opens a real Chrome, looks once, reports the title in a few steps. No Playwright, no vision model, no cloud.

Every other browser agent buries the model under a 20–30-tool MCP surface and a raw-DOM firehose. pixelpi gives it **six primitives** and a bounded view of the page — `look()` is **107× cheaper** than a raw-DOM dump on a heavy site, and stays flat as the page grows. The model already knows how to use a browser; pixelpi just hands it one.

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

## The six primitives

```
look · act · fill · nav · eval · store
```

- **`look(mode?, filter?)`** — compact, ref-indexed accessibility/DOM snapshot. The `read`.
- **`act(ref, op, value?)`** — mutate the page by stable ref via trusted CDP input events. The `write`/`edit`.
- **`fill(fields[])`** — batched form fill in one call.
- **`nav(action, arg?)`** — navigate, tabs, `waitfor`. The `cd` / processes.
- **`eval(fn, args?, opts?)`** — arbitrary JS in the page realm. The escape hatch — the `bash` of the browser.
- **`store(action, key?, value?)`** — durable host-side JSON KV. The filesystem.

Elements are addressed by **stable ref** (not CSS/coordinates) — cheap, deterministic, resilient to layout churn. Everything else is composable from `eval`; the agent writes its own higher-level tools as JSON skills at runtime, and only each skill's one-line description enters the prompt.

## Why it's different

| | pixelpi | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|
| Tools in context | **6** | 21 | 31 |
| Tool-def + prompt tokens | **~1,055** | ~13,700 | ~18,000 |
| Page representation | a11y tree (bounded) | mixed | mixed |
| Substrate | **raw CDP** (no Playwright) | Playwright | CDP |
| Self-extension | agent writes JS skills at runtime | — | — |

**Validated token cost** (`look()` vs naive raw-DOM dump, measured live):

| Site | `look()` | raw DOM | factor |
|---|---|---|---|
| stripe.com | 1,667 tok | 177,826 tok | **107× cheaper** |
| react.dev | 2,421 tok | 68,130 tok | **28× cheaper** |
| news.ycombinator.com | 1,837 tok | 8,612 tok | 4.7× |

`look()` output is **bounded** (a hard ref cap) while raw DOM scales with page weight — so the heavier the site, the bigger the win.

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

More in [`examples/`](./examples).

## Philosophy

The model is the harness now — so you expose the substrate's irreducible primitives and let the agent compose the rest. See [docs/how-it-works.md](./docs/how-it-works.md) for the moving parts (why six tools, why raw CDP, why no MCP).

## Contributing

Issues and PRs welcome. Run `pnpm install && pnpm build && pnpm test` before opening a PR. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status

Substrate (`look`/`eval`) is validated live against real sites. The agent loop, guards, stores, and provider adapters are unit-tested (74 tests, mock provider — no network in tests). The full LLM↔browser loop runs once you supply an API key. Requires Node ≥ 20 and Google Chrome.

## License

MIT © 2026 Harsh Joshi
