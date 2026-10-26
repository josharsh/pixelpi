# PixelPi / Pomerado benchmark investigation — 2026-10-26

**Verdict: PixelPi's context efficiency is measurable; its enterprise task performance versus Pomerado is unknown. A real replay error-reporting bug was reproduced.**

The exact requested comparison could not be run. Pomerado publishes aggregate scores, but I did not find its 30 task prompts, graders, seeded environments, credentials, or per-task logs in the public website, launch post, docs index, or public repositories. The user confirmed there is no separate benchmark pack available and requested continuing with tests that need no API key. No substitute test below is presented as the same benchmark.

## Published comparison, not independently reproduced

The [Pomerado homepage](https://pomerado.ai/) embeds these values in its chart:

| System | Success | Median minutes/task | Reported model $/task |
|---|---:|---:|---:|
| Pomerado / Astra | 100% | 4.62 | $1.62 |
| Pomerado / Luna | 90% | 5.94 | $0.02 |
| Computer Use / Astra | 76.67% | 8.74 | $13.63 |
| Muse | 70% | 24.28 | Not reported |
| Instinct | 60% | 13.47 | Not reported |

The stated protocol is 30 tasks across 25 apps, one attempt each. Pomerado's runs use Codex with previously built APIs. Costs cover model tokens at list prices; the published execution comparison does not establish full build, maintenance, hosting, or subscription costs.

Calculated from the displayed numbers:

- Astra versus Astra: **1.89× faster**, **8.41× lower model cost**, **23.33 percentage points** higher success, approximately **30.4% relative improvement**.
- Luna versus Astra Computer Use: **1.47× faster**, **681.5× lower model cost**, with a different model and 90% success.

These are calculations on vendor claims, not PixelPi results. The headline combines different configurations; it is not a uniform advantage for every pairing. A single attempt per task does not measure repeated-run reliability or self-healing under controlled website changes.

[Extracted vendor data, source asset URL/hash, app list, and repository revision](results/pomerado-2026-10-26/vendor-results.json). Public repository checked: [Pomerado/pomerado](https://github.com/Pomerado/pomerado).

## Measured PixelPi context cost

PixelPi **0.6.1**, commit `2579d5563180f3d18eb4bebe5b6631439b583a65`; Playwright MCP **0.0.83**; Chrome **155.0.8059.86**; Node **20.17.0**; macOS; headless Chrome; `o200k_base` tokenizer. No model calls.

| Tool definitions | Tools | Tokens |
|---|---:|---:|
| PixelPi | 6 | 1,196 |
| Playwright MCP | 25 | 6,551 |

**5.48× fewer serialized tool-definition tokens.**

| Site | PixelPi page tokens | Playwright MCP page tokens | Ratio |
|---|---:|---:|---:|
| Hacker News | 4,107 | 12,481 | 3.04× |
| arXiv | 4,909 | 13,280 | 2.71× |
| GitHub | 2,548 | 7,481 | 2.94× |
| Coursera | 3,245 | 9,570 | 2.95× |
| Hugging Face | 2,742 | 9,329 | 3.40× |
| Apple | 18,465 | 27,258 | 1.48× |

**Arithmetic mean of per-site ratios: 2.75×**, below the repository's older 3.33× result. Site content and the baseline version have changed; this alone is not evidence of a PixelPi code regression. The Apple result particularly weakens the current average.

The existing script sums PixelPi's rendered pages until no pagination remains, versus Playwright MCP's snapshot. These were separate live sessions with different observation times, not identical frozen DOMs. Matching semantic coverage was not independently verified. This measures representation size, not billed model cost, latency, task completion, or enterprise reliability.

[Machine-readable measurements](results/pomerado-2026-10-26/context-cost.json) · [Console output](results/pomerado-2026-10-26/context-cost.txt)

## Live agent attempt: no valid capability score

The existing five-task retrieval pilot was attempted with the configured `claude-sonnet-4-6`. Anthropic returned **HTTP 401** before any model response or browser task action. Its old summary incorrectly printed **0/5 (0%)**. That is an authentication/setup failure, not a measured task success rate.

The runner now checks `stopReason`, separates errors/unscored/not-run tasks from evaluated tasks, stops after a fatal credential/model/quota error, emits JSON with full answers and timing, and returns a nonzero exit status for incomplete runs. The corrected verification reports **success N/A, 0/5 evaluated**, with one credential error and four tasks not run. Each task uses an isolated in-memory store. A valid completed pilot would still only establish performance on five simple retrieval tasks.

[Corrected result](results/pomerado-2026-10-26/live-tasks.json) · [Original misleading output, explicitly marked invalid](results/pomerado-2026-10-26/original-invalid-task-run.txt)

## Real-browser replay diagnostics

Three hand-authored traces ran against a local fixture using actual PixelPi replay and fresh Chrome launches. There was no model, recording/build stage, or manual rescue. Each scenario ran once. These deliberately selected probes are **not a statistical reliability benchmark**.

| Probe | Observed behavior | Interpretation |
|---|---|---|
| Extract current heading | Correct fresh value, `ok: true`, 567 ms | Basic deterministic extraction works |
| Required selector absent; extraction throws | Error text returned as `output`, but `ok: true` and step status `ok`, 372 ms | Confirmed false-success bug |
| Navigate only; saved answer differs from current page | `ok: true`, no fresh output, old recorded `finalText`, 397 ms | Replay does not regenerate an answer from navigation alone |

The error case is reproducible in `replayTrace`: the `eval` branch receives `ToolResult.isError` but does not check it before marking the step successful. In this probe, the output was `Error: Required heading missing`. Callers trusting `ok` can therefore count a broken extraction as success. The probe uses strict replay (`heal: false`); it does not measure model-assisted repairs.

The stale-answer case is a contract limitation: `finalText` is copied from the recording. Consumers must validate fresh `output` or independently inspect final state. A replay returning `ok: true` is not sufficient proof that the original user goal was achieved.

[Reproduction script](replay-probe.ts) · [Raw results](results/pomerado-2026-10-26/replay-probe.json). Production replay behavior was left unchanged to preserve the tested baseline.

## Reproduce and complete the comparison

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm bench:tokens
pnpm exec tsx bench/replay-probe.ts --out replay-probe.json
node --import tsx --test bench/task-scoring.test.ts
# Requires a valid local ANTHROPIC_API_KEY; do not paste a key into chat:
node --env-file=.env --import tsx bench/tasks.ts --out live-tasks.json
```

`bench:tokens` currently resolves Playwright MCP's latest release; the measured version above is recorded for audit. The replay probe exits 1 on the confirmed bug/limitation. An incomplete live pilot exits 2.

Validation: build and workspace typechecks passed; the benchmark files also passed a direct TypeScript check. All four new scoring regression tests and 19 existing record/replay unit tests passed. The real-browser probe still exposed the false-success bug, which the existing mocked tests do not cover. `git diff --check` passed.

For an actual head-to-head, obtain the original task/environment/grader pack and run both systems on identical reset states with independent output/state verification. Report PixelPi's first solve/record cost separately from replay, and Pomerado's build cost separately from API execution. Match the model where feasible, retain all failures, measure wall time and token usage per task, and include repeated runs plus controlled site changes before making reliability or healing claims.

The immediate engineering priority revealed by these tests is error propagation and fresh-output validation in replay. The current evidence supports a smaller browser representation; it does not support claiming PixelPi beats Pomerado on enterprise workflows.
