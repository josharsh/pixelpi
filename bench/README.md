# bench

The scripts behind the numbers in the README. Run them yourself.

## Token cost — `efficiency.ts`

How many tokens `look()` costs the model, versus dumping the raw DOM. Runs against 15 popular sites (the list is borrowed from [WebVoyager](https://github.com/MinorJerry/WebVoyager)). No API key needed.

```bash
pnpm install && pnpm build
pnpm bench:tokens
```

Measured 2026-06-17, headless Chrome:

| Site | look() | raw DOM | factor |
|---|---|---|---|
| Coursera | 1,997 | 202,892 | 101.6× |
| GitHub | 1,955 | 146,787 | 75.1× |
| Apple | 2,254 | 96,507 | 42.8× |
| Wolfram | 1,245 | 45,667 | 36.7× |
| Hugging Face | 1,932 | 45,300 | 23.4× |
| BBC | 4,198 | 83,117 | 19.8× |
| ArXiv | 1,588 | 10,652 | 6.7× |

Median 37×, mean 44× across the seven sites that loaded. `look()` holds around 2k tokens whatever the page weighs; the raw DOM just keeps growing.

The other five (Amazon, Booking, ESPN, Allrecipes, Cambridge) served a near-empty page to headless Chrome — bot detection. pixelpi can't act on a page it can't see, and getting past that needs a real browser profile, which isn't built yet.

## Tasks — `tasks.ts`

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

5/5, about 2¢ a task. These are easy single-page lookups, not multi-step flows — it shows the cost holds up on simple tasks, nothing more.
