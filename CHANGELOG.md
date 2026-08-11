# Changelog

All notable changes to `pixelpi` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, the minor version carries
breaking changes.

Versions below refer to the `pixelpi` CLI/SDK package. The `@josharsh/pixelpi-{ai,core,cdp}`
packages version independently and are only listed when they changed.

## [Unreleased]

### Added

- **`pixelpi mcp` — an MCP server over stdio.** One line of config in Claude Code or Cursor and
  the six primitives are available to whatever model that client already pays for; no API key,
  no provider setup. This is the form factor the context-budget claim was always about: in a CLI
  nobody sees a tool definition, but MCP serializes them into the prompt on every call, and here
  it is 1,196 tokens against Playwright MCP's 5,953.

  Supports `--allow-domains`, `--dry-run`, `--confirm`, `--profile`, and `--store`. Under
  `--confirm` there is no TTY to ask at, so consequential actions are refused with the reason
  handed back to the calling model. Chrome launches on the first tool call rather than at
  startup, so listing tools costs nothing, and it is closed on client disconnect, SIGINT, and
  SIGTERM — an orphaned headless Chrome would hold the profile lock and break the next run.

  Hand-rolled rather than built on `@modelcontextprotocol/sdk`, which pulls express, hono, cors,
  jose, ajv and zod for what is, on stdio, five request types.

- **A test that guards the thesis.** `mcp.test.ts` asserts the six tool definitions stay under
  the published token budget, so a seventh tool or a description that grows fails CI before it
  quietly invalidates the README.

## [0.5.0] — 2026-08-11

Also releases `@josharsh/pixelpi-cdp` 0.3.0. `look()`'s output changes shape in this release:
fewer, denser refs, different ref numbering, and a new header format. Recorded traces resolve
targets by accessibility role and name rather than by ref number, so they keep working — and
traces that pointed at an element beyond ref 200 can resolve for the first time.

### Added

- **`look` takes an `offset`.** A single call still renders 200 refs, but the header now reports the
  total and tells the agent how to page: `353 refs — showing 1-200; look again with offset=200`.
- **`eval` takes an `opts.offset`.** Returns are still capped at 8000 characters per call, but the
  truncation marker now reports the total and the offset to resume from, so bulk extraction can
  actually finish. The tool description promised bulk extraction; the implementation now delivers it.

### Fixed

- **`look`'s `filter` searched only the first 200 refs.** Compaction hard-capped at `MAX_REFS` and
  the filter ran over the already-truncated list, so an element at position 201 or beyond was
  unreachable by any query. Compaction is now uncapped and the window is applied at render time, so
  `filter` searches the whole page and every ref stays addressable by `act`/`fill`.
- **`look` emitted the same content twice.** The accessibility tree describes a Hacker News row both
  as an aggregating table cell and again as the decomposed links and text inside it. Non-interactive
  nodes repeating an already-emitted name are now dropped. Interactive nodes and table cells are
  exempt — two buttons named "Submit" are two things to click, and repeated cell values are data.
- **`look` spent tokens on punctuation.** Separator-only nodes (`" | "`, `" ("`, `")"`) were 22% of
  the lines on Hacker News. Non-interactive nodes whose name has no letter or digit are now dropped.

Together these cut Hacker News from 811 nodes to 351 and the full-page cost from roughly 10,000
tokens to 3,972 — while making the whole page reachable for the first time.

### Changed

- **`bench/efficiency.ts` measures against Playwright MCP, not a raw-DOM dump**, and counts tokens
  with `o200k_base` instead of a `chars/4` estimate that understated real counts by ~25%. The old
  "37× to 100× fewer tokens than raw DOM" comparison was against a baseline nobody ships to a model;
  the honest figures against `@playwright/mcp` are 5.0× on tool definitions and 3.33× per page.
- **README repositioned around the context budget** — the fixed cost of tool definitions, paid on
  every call, rather than a headline page-compression ratio.

## [0.4.0] — 2026-07-30

### Added

- **Mid-run self-healing for `run --heal`.** When a fan-out row drifts, one worker repairs the
  shared trace with the model and every other drifted row reuses that repair instead of failing.
  Previously only the warm-up row could heal, so a site that changed at row 900 of a 5,000-row
  batch failed every row from there on. ([#26](https://github.com/josharsh/pixelpi/pull/26))
- `--max-heals <n>` (default `3`): the mid-run repair budget for a batch. Past it, drifted rows are
  reported exactly as before and the reason is warned once, so a genuinely broken site cannot cost
  one model run per row.
- `RunSummary.healed` — mid-run repairs spent — surfaced in the `run` summary line and in the
  `--json` `summary` event.

### Changed

- `run` fan-out rows still replay strictly on the fast path; healing is only attempted on a drift,
  and only under `--heal`. Behavior without `--heal` is unchanged, as is `replay` and the SDK's
  `.over()`.

## [0.3.2] — 2026-07-22

### Fixed

- `pixelpi login` opens a plain headed Chrome with no debug port, so bot-walls on sites like X and
  Google no longer block sign-in. The session is flushed to the profile on a graceful close.
- Chrome launches with `--disable-blink-features=AutomationControlled`, clearing
  `navigator.webdriver` so real-site login and runs are not flagged as automation.
  (`@josharsh/pixelpi-cdp` 0.2.2)

## [0.3.1] — 2026-07-22

### Fixed

- Fail fast with an actionable error when a persistent `--profile` is already owned by a live or
  orphaned Chrome. Instead of polling for 15s and suggesting you close a window that may not exist,
  pixelpi resolves the owning pid from the profile's singleton lock and hands you a `kill <pid>`.
  (`@josharsh/pixelpi-cdp` 0.2.1)

## [0.3.0] — 2026-07-14

### Added

- **Deterministic guardrails, enforced at the tool layer rather than in the prompt:**
  - `--allow-domains a.com,b.com` — a navigation fence. Off-list `goto`/`newtab` are refused, and
    off-fence link clicks or JS redirects bounce back.
  - `--dry-run` — read and fill normally, but withhold consequential clicks (submit, send, pay,
    publish) and report what *would* have been committed.
  - `--confirm` — same detection, but pause for an explicit y/N. Non-interactive or under `--json`
    the action is denied and a `pending_action` event is emitted.
  - `--max-tokens <n>` — a total input+output budget that warns at 80% and stops cleanly.
- `BLOCKED: <reason>` as a first-class stop reason (CLI exit code `4`) for when the target is
  unreachable or required form data was never provided — instead of substituting a different goal
  or inventing field values.
- Context is bounded by default: tool results older than the last 8 exchanges are elided per
  provider call, so cost grows linearly with steps rather than quadratically.

### Fixed

- `--profile` keeps authentication but not the previous run's page, and a relaunch no longer sticks.

## [0.2.2] — 2026-07-06

### Fixed

- Serve README images via jsDelivr; GitHub rate-limits `raw.githubusercontent.com` on npmjs.com.

## [0.2.0] — 2026-06-27

### Added

- **Parametrized traces and `pixelpi run`:** record a task once with an example input, then map it
  over a CSV or JSONL in parallel for roughly zero tokens per row. Bounded by `--concurrency`, with
  outcomes streamed to JSONL (`--out`), `--resume` to skip completed rows, and a warm-up row that
  runs alone so a single `--heal` repair benefits the rest of the batch.
- `pixelpi describe <trace>` — a trace's signature (inputs, output, usage) for humans and agents.
- A callable SDK: `loadTrace(name)` returns a function with `.describe()` and `.over(rows)`, with
  no model or API key required.

## [0.1.6] — 2026-06-22

### Added

- **Record and replay.** `--record <name>` saves a solved run as a trace; `pixelpi replay <name>`
  reruns it with no model in the loop for zero tokens. Traces key on the accessibility role and
  name of each element, not CSS selectors or coordinates, so they survive most layout changes.
- `replay --heal` re-derives just the drifted step with the model and rewrites the trace. Strict
  replay needs no API key and exits `3` on drift, naming the step that no longer matches.

## [0.1.4] — 2026-06-20

### Added

- Cross-platform Chrome detection (macOS, Linux, Windows), overridable with `PIXELPI_CHROME`.
- Persistent profiles: `pixelpi login <url>` to sign in once, `--profile` to reuse that session.

## [0.1.0] — 2026-06-17

Initial release, published as `pixelpi` plus `@josharsh/pixelpi-{ai,core,cdp}`.

### Added

- Six browser primitives over raw Chrome DevTools Protocol — `look`, `act`, `fill`, `nav`, `eval`,
  `store` — with no Playwright and no MCP.
- `look()` returns a compact, ref-indexed accessibility snapshot: about 2,000 tokens for any page,
  versus a raw DOM dump that keeps growing with the site.
- A provider-agnostic agent loop (Anthropic and OpenAI), an interactive REPL, guided onboarding,
  and a reproducible token benchmark in [`bench/`](bench).

[Unreleased]: https://github.com/josharsh/pixelpi/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/josharsh/pixelpi/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/josharsh/pixelpi/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/josharsh/pixelpi/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/josharsh/pixelpi/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/josharsh/pixelpi/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/josharsh/pixelpi/compare/v0.2.0...v0.2.2
[0.2.0]: https://github.com/josharsh/pixelpi/compare/v0.1.6...v0.2.0
[0.1.6]: https://github.com/josharsh/pixelpi/compare/v0.1.4...v0.1.6
[0.1.4]: https://github.com/josharsh/pixelpi/compare/v0.1.0...v0.1.4
[0.1.0]: https://github.com/josharsh/pixelpi/releases/tag/v0.1.0
