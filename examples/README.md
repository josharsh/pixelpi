# Examples

Runnable, copy-paste snippets. Each is self-contained.

| File | What it shows | Needs a key? |
|------|---------------|--------------|
| [`hn-top-story.ts`](./hn-top-story.ts) | The simplest end-to-end task via the SDK | yes |
| [`extract-prices.ts`](./extract-prices.ts) | Structured extraction with a live event stream | yes |
| [`primitives-only.ts`](./primitives-only.ts) | Driving `look` + `eval` directly — no LLM | no |

Run any of them with `tsx`:

```bash
# with a model (Anthropic by default):
ANTHROPIC_API_KEY=sk-... pnpm dlx tsx examples/hn-top-story.ts

# no key needed — pure substrate:
pnpm dlx tsx examples/primitives-only.ts
```

All examples need Google Chrome installed (auto-detected on macOS; set `PIXELPI_CHROME` otherwise).
