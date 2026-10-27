"""Validate and summarize the complete run; optionally draw a shareable chart.

python3 bench/comparison/summarize.py bench/results/playwright-2026-10-26
Use --chart with matplotlib installed to also render PNG and SVG artifacts.
"""
import argparse
import json
from pathlib import Path
from statistics import median

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
parser.add_argument("--chart", action="store_true")
args = parser.parse_args()
directory = args.directory
manifest = json.loads((directory / "manifest.json").read_text())
environment = json.loads((directory / "environment.json").read_text())
rows = [json.loads(line) for line in (directory / "trials.jsonl").read_text().splitlines()]
systems = ["pixelpi", "playwright-mcp", "playwright-script"]
task_ids = [t["id"] for t in manifest["tasks"]]
repeats = manifest["repeats"]
expected_keys = {(r, t, s) for r in range(repeats) for t in task_ids for s in systems}
actual_keys = [(r["repeat"], r["task"], r["system"]) for r in rows]
assert len(actual_keys) == len(set(actual_keys)), "Duplicate trials"
assert set(actual_keys) == expected_keys, "Incomplete or unexpected trials"
assert all(r["ms"] is not None and r["bootMs"] is not None for r in rows), "Setup failure"

by_task = {}
for task in task_ids:
    by_task[task] = {}
    for system in systems:
        selected = [r for r in rows if r["task"] == task and r["system"] == system]
        by_task[task][system] = {
            "passes": sum(r["pass"] for r in selected),
            "trials": len(selected),
            "median_ms": median(r["ms"] for r in selected),
            "min_ms": min(r["ms"] for r in selected),
            "max_ms": max(r["ms"] for r in selected),
            "median_output_tokens": median(r["outputTokens"] for r in selected),
            "median_argument_tokens": median(r["inputTokens"] for r in selected),
            "median_tool_calls": median(r["toolCalls"] for r in selected),
            "silent_failures": sum(r["falseSuccess"] for r in selected),
        }

# The same exact tasks enter all three latency/context aggregates.
common = [t for t in task_ids if all(by_task[t][s]["passes"] == repeats for s in systems)]
summary = {
    "total_trials": len(rows),
    "repeats": repeats,
    "tasks": by_task,
    "common_success_tasks": common,
    "systems": {},
    "definition_tokens": environment["definitionTokens"],
}
for system in systems:
    selected = [r for r in rows if r["system"] == system]
    summary["systems"][system] = {
        "passes": sum(r["pass"] for r in selected),
        "trials": len(selected),
        "silent_failures": sum(r["falseSuccess"] for r in selected),
        "median_boot_ms": median(r["bootMs"] for r in selected),
        "sum_common_task_medians_ms": sum(by_task[t][system]["median_ms"] for t in common),
        "sum_common_task_median_output_tokens": sum(by_task[t][system]["median_output_tokens"] for t in common),
        "sum_common_task_median_argument_tokens": sum(by_task[t][system]["median_argument_tokens"] for t in common),
    }
pp = summary["systems"]["pixelpi"]
pw = summary["systems"]["playwright-mcp"]
direct = summary["systems"]["playwright-script"]
summary["ratios"] = {
    "playwright_mcp_over_pixelpi_time_common_tasks": pw["sum_common_task_medians_ms"] / pp["sum_common_task_medians_ms"],
    "pixelpi_over_direct_script_time_common_tasks": pp["sum_common_task_medians_ms"] / direct["sum_common_task_medians_ms"],
    "playwright_mcp_over_pixelpi_output_tokens_common_tasks": pw["sum_common_task_median_output_tokens"] / pp["sum_common_task_median_output_tokens"],
    "mean_per_common_task_output_token_ratio": sum(by_task[t]["playwright-mcp"]["median_output_tokens"] / by_task[t]["pixelpi"]["median_output_tokens"] for t in common) / len(common),
    "normalized_compact_definition_token_ratio": environment["definitionTokens"]["playwright-mcp"]["normalizedCompact"] / environment["definitionTokens"]["pixelpi"]["normalizedCompact"],
}
(directory / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

lines = ["| Task | PixelPi pass | PW MCP pass | PW script pass | PixelPi ms | PW MCP ms | PW script ms |", "|---|---:|---:|---:|---:|---:|---:|"]
for task in task_ids:
    values = [by_task[task][system] for system in systems]
    passes = [f'{v["passes"]}/{v["trials"]}' for v in values]
    times = [str(round(v["median_ms"])) if v["passes"] == repeats else "—" for v in values]
    lines.append("| " + " | ".join([task] + passes + times) + " |")
lines.extend(["", f"Times are medians of {repeats} trials; failed tasks have no speed score.", "", "Common successful tasks: " + ", ".join(common), "", "| Task | PixelPi output tokens | PW MCP output tokens | Ratio |", "|---|---:|---:|---:|"])
for task in common:
    a = by_task[task]["pixelpi"]["median_output_tokens"]
    b = by_task[task]["playwright-mcp"]["median_output_tokens"]
    lines.append(f"| {task} | {a:,} | {b:,} | {b/a:.2f}× |")
(directory / "tables.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"systems": summary["systems"], "ratios": summary["ratios"]}, indent=2))

if args.chart:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "axes.spines.top": False, "axes.spines.right": False, "axes.spines.left": False})
    colors = ["#27644b", "#64748b", "#b28a4b"]
    names = ["PixelPi MCP", "Playwright MCP", "Playwright script"]
    fig, axes = plt.subplots(1, 3, figsize=(15, 6.6), gridspec_kw={"width_ratios": [1, 1.1, 1.2]})
    fig.patch.set_facecolor("#faf9f6")
    fig.suptitle("PixelPi vs Playwright: the tradeoff", x=0.06, y=0.97, ha="left", fontsize=24, fontweight="bold")
    fig.text(0.06, 0.895, f"{len(rows)} controlled trials · {len(task_ids)} synthetic tasks · no model calls", color="#535b61", fontsize=13)
    for ax in axes:
        ax.set_facecolor("#faf9f6")
        ax.tick_params(axis="y", length=0)
        ax.grid(axis="x", alpha=0.15)
        ax.set_axisbelow(True)
    defs = [environment["definitionTokens"][s]["normalizedCompact"] for s in systems[:2]]
    axes[0].barh(names[:2], defs, color=colors[:2], height=0.5)
    axes[0].invert_yaxis()
    axes[0].set_xlim(0, max(defs)*1.27)
    axes[0].set_title("Tool definitions\nLess context", loc="left", pad=22, fontweight="bold")
    axes[0].set_xlabel("Normalized compact schema tokens")
    for y,v in enumerate(defs): axes[0].text(v+50,y,f"{v:,}",va="center",fontweight="bold")
    passes = [summary["systems"][s]["passes"] for s in systems]
    totals = [summary["systems"][s]["trials"] for s in systems]
    axes[1].barh(names, totals, color="#e7e6e2", height=0.5)
    axes[1].barh(names, passes, color=colors, height=0.5)
    axes[1].invert_yaxis()
    axes[1].set_xlim(0,max(totals)*1.27)
    axes[1].set_title("Verified outcomes\nExact outcome checks", loc="left", pad=22, fontweight="bold")
    axes[1].set_xlabel("Passed trials in this fixture suite")
    for y,(a,b) in enumerate(zip(passes,totals)): axes[1].text(b+1,y,f"{a}/{b}",va="center",fontweight="bold")
    times = [summary["systems"][s]["sum_common_task_medians_ms"]/1000 for s in systems]
    axes[2].barh(names, times, color=colors, height=0.5)
    axes[2].invert_yaxis()
    axes[2].set_xlim(0,max(times)*1.27)
    axes[2].set_title(f"Same {len(common)} passing tasks\nDirect scripts fastest", loc="left", pad=22, fontweight="bold")
    axes[2].set_xlabel("Sum of per-task median seconds")
    for y,v in enumerate(times): axes[2].text(v+0.12,y,f"{v:.2f}s",va="center",fontweight="bold")
    fig.text(0.06,0.12,"Prewritten task plans; fresh Chrome per trial. Time excludes startup, judging and tokenization; default tool waits retained.",fontsize=10,color="#535b61")
    fig.text(0.06,0.08,"Full-snapshot MCP workflow. This is not an autonomous-agent benchmark or a general reliability estimate.",fontsize=10,color="#535b61")
    fig.text(0.06,0.04,f"Raw data: bench/results/{directory.name} · Reproduce: pnpm bench:compare",fontsize=9,color="#535b61")
    fig.subplots_adjust(left=0.12,right=0.97,top=0.73,bottom=0.29,wspace=0.9)
    fig.savefig(directory/"comparison.png",dpi=180,facecolor=fig.get_facecolor())
    fig.savefig(directory/"comparison.svg",facecolor=fig.get_facecolor())
