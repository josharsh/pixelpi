# Contributing to pixelpi

Thanks for helping. pixelpi stays small on purpose — six primitives over raw CDP,
a sub-1,100-token prompt, any model. Keep contributions in that spirit: lean,
explicit, no hype.

## Prerequisites

- Node >= 20
- pnpm (the repo pins a version via `packageManager`; run `corepack enable` if you don't have it)
- Chrome / Chromium installed (the agent drives a real browser)

## Setup

```bash
pnpm install
```

Then the usual loop:

```bash
pnpm test        # vitest, offline — no browser or API key needed
pnpm typecheck   # tsc across all packages
pnpm build       # tsup build across all packages
```

## Monorepo layout

This is a pnpm workspace. Dependency order is `ai → core → cdp → agent`.

- `packages/ai` (`@josharsh/pixelpi-ai`) — provider adapters; turns any model into a uniform LLM interface.
- `packages/core` (`@josharsh/pixelpi-core`) — the agent loop, tool/event types, and the store.
- `packages/cdp` (`@josharsh/pixelpi-cdp`) — the six browser primitives over raw Chrome DevTools Protocol, plus the compact `look()` snapshot.
- `packages/agent` (`pixelpi`) — the unscoped CLI and the session/REPL that wires everything together.

## Trying it out

The [`examples/`](./examples) directory has runnable snippets. `examples/primitives-only.ts`
drives `look()` and `eval()` against a real page with no LLM in the loop — a good way to see
the substrate work (needs Chrome, no API key):

```bash
pnpm dlx tsx examples/primitives-only.ts
```

## Branch and PR flow

1. Fork (or branch) off `main`. Use a short topic branch like `fix-look-truncation`.
2. Make the change. Keep the diff focused — one concern per PR.
3. Make sure `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.
4. Open the PR against `main` and fill out the template.

Versioning and publishing to npm are handled manually by the maintainer — you don't need to bump versions.

## Code style

- Prettier defaults. Don't bikeshed formatting — let the formatter decide.
- 2-space indentation, ESM TypeScript throughout.
- Co-locate tests with source (`foo.ts` + `foo.test.ts`). Test the logic that can break; skip glue.
- No TODOs in merged code. Finish it or leave it out.
