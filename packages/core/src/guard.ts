import type { AgentEvent, GuardConfig, Tool, ToolContext, ToolResult } from "./types";
import { stableStringify } from "./stableStringify";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic reliability around a single tool execution: retry-with-backoff on throw,
 * and loop detection that short-circuits an identical (name,input) that keeps failing.
 * Holds the per-signature fail counts across the whole run (one Guard per runAgent).
 */
export class Guard {
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly loopThreshold: number;
  private readonly failCounts = new Map<string, number>();

  constructor(cfg: GuardConfig = {}) {
    this.maxRetries = cfg.maxRetries ?? 3;
    this.retryBaseMs = cfg.retryBaseMs ?? 250;
    this.loopThreshold = cfg.loopThreshold ?? 2;
  }

  async run(
    step: number,
    tool: Tool,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const signature = tool.name + ":" + stableStringify(input);
    const priorFails = this.failCounts.get(signature) ?? 0;

    if (priorFails >= this.loopThreshold) {
      const detail = `${tool.name} with these args has failed ${priorFails} times`;
      ctx.emit({ type: "guard", step, reason: "loop", detail });
      return {
        content:
          `This exact call (${tool.name}) has already failed ${priorFails} times. ` +
          `Stop repeating it — try a different approach, different arguments, or a different tool.`,
        isError: true,
      };
    }

    let result: ToolResult;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await tool.execute(input, ctx);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < this.maxRetries) {
          await sleep(this.retryBaseMs * 2 ** attempt);
          ctx.emit({ type: "tool_retry", step, name: tool.name, attempt: attempt + 1, error: msg });
          continue;
        }
        result = { content: "Tool threw: " + msg, isError: true };
        break;
      }
    }

    if (result.isError) this.failCounts.set(signature, priorFails + 1);
    else this.failCounts.delete(signature);

    return result;
  }
}

export type EmitFn = (event: AgentEvent) => void;
