import type { AgentEvent } from "@josharsh/pixelpi-core";
import type { Snapshot, SnapshotDelta } from "@josharsh/pixelpi-cdp";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

let useColor =
  !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

/** Toggle ANSI color (the CLI sets this from flags / NO_COLOR / TTY detection). */
export function setColorEnabled(enabled: boolean): void {
  useColor = enabled;
}

function color(c: string, s: string): string {
  return useColor ? `${c}${s}${C.reset}` : s;
}

function truncate(s: string, max = 240): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function compactInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return truncate(json, 160);
}

/** Pull a ref count out of a tool observation if it is a Snapshot/SnapshotDelta. */
function refCount(observation: unknown): number | undefined {
  if (observation && typeof observation === "object" && "refs" in observation) {
    const refs = (observation as Snapshot | SnapshotDelta).refs;
    if (Array.isArray(refs)) return refs.length;
  }
  return undefined;
}

export function renderEvent(e: AgentEvent): void {
  switch (e.type) {
    case "agent_start":
      console.log(color(C.dim, `tools: ${e.toolNames.join(", ")}`));
      break;
    case "turn_start":
      console.log(color(C.bold, `\n── turn ${e.step} ──`));
      break;
    case "assistant_message": {
      for (const block of e.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(color(C.cyan, truncate(block.text, 400)));
        }
      }
      break;
    }
    case "tool_start":
      console.log(`${color(C.magenta, "→ " + e.name)} ${color(C.dim, compactInput(e.input))}`);
      break;
    case "tool_end": {
      const { result } = e;
      const tag = result.isError ? color(C.red, "✗") : color(C.green, "✓");
      const refs = refCount(result.observation);
      const refNote = refs !== undefined ? color(C.dim, ` [${refs} refs]`) : "";
      console.log(`${tag} ${color(C.dim, e.name)}${refNote} ${color(C.dim, `(${e.ms}ms)`)} ${truncate(result.content)}`);
      break;
    }
    case "tool_retry":
      console.log(color(C.yellow, `↻ ${e.name} retry ${e.attempt}: ${truncate(e.error, 120)}`));
      break;
    case "guard":
      console.log(color(C.yellow, `⚠ guard ${e.reason}: ${e.detail}`));
      break;
    case "agent_end":
      console.log(
        color(C.bold, `\n■ ${e.reason}`) +
          color(C.dim, ` — ${e.step} steps, ${e.usage.inputTokens}in/${e.usage.outputTokens}out tokens`),
      );
      break;
    case "log":
      if (e.level === "error") console.log(color(C.red, `[error] ${e.message}`));
      else if (e.level === "warn") console.log(color(C.yellow, `[warn] ${e.message}`));
      else console.log(color(C.dim, `[${e.level}] ${e.message}`));
      break;
  }
}
