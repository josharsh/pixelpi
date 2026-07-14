import type {
  ContentBlock,
  LLMMessage,
  ToolResultBlock,
  ToolSchema,
  ToolUseBlock,
} from "@josharsh/pixelpi-ai";
import type { CompletionResponse, LLMProvider } from "@josharsh/pixelpi-ai";
import type { AgentEvent, AgentOptions, AgentResult, AgentStopReason, Tool, Usage } from "./types";
import { Guard } from "./guard";

// Run a single provider.complete with a short-lived child AbortController.
// The parent run signal is forwarded via a listener that is removed once the
// call settles, so at most one transient listener sits on the parent at a time
// and they never accumulate across turns (avoids MaxListenersExceededWarning).
async function completeWithChildSignal(
  provider: LLMProvider,
  req: Parameters<LLMProvider["complete"]>[0],
  parent: AbortSignal | undefined,
): Promise<CompletionResponse> {
  if (!parent) {
    return provider.complete(req);
  }
  const child = new AbortController();
  if (parent.aborted) {
    child.abort(parent.reason);
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  try {
    return await provider.complete({ ...req, signal: child.signal });
  } finally {
    parent.removeEventListener("abort", onAbort);
  }
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolUsesOf(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

const ELIDE_OVER = 600;
const ELIDE_KEEP = 200;

/**
 * Bound the context (#24): keep the last `keepRecent` tool-result exchanges verbatim and
 * elide the body of older, larger tool results (a stale snapshot from 40 steps ago is
 * dead weight the model resends every turn). Pure — returns a fresh array; the canonical
 * conversation in `messages` is never mutated.
 */
export function pruneToolResults(messages: LLMMessage[], keepRecent: number): LLMMessage[] {
  const withResults: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.content.some((b) => b.type === "tool_result")) withResults.push(i);
  }
  const elide = new Set(withResults.slice(0, Math.max(0, withResults.length - keepRecent)));
  if (elide.size === 0) return messages;
  return messages.map((m, i) => {
    if (!elide.has(i)) return m;
    return {
      ...m,
      content: m.content.map((b) =>
        b.type === "tool_result" && b.content.length > ELIDE_OVER
          ? {
              ...b,
              content:
                b.content.slice(0, ELIDE_KEEP) +
                `\n…[${b.content.length - ELIDE_KEEP} chars elided — stale earlier observation; look again if needed]`,
            }
          : b,
      ),
    };
  });
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const {
    provider,
    model,
    system,
    tools,
    maxSteps = 50,
    maxTokens,
    maxTotalTokens,
    maxTokensPerCall,
    keepRecentToolResults = 8,
    temperature,
    signal,
    guards,
    onEvent,
  } = opts;

  const messages: LLMMessage[] = [...opts.messages];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const emit = (event: AgentEvent) => onEvent?.(event);
  const toolSignal = signal ?? new AbortController().signal;

  const toolSchemas: ToolSchema[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const toolByName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  const guard = new Guard(guards);

  emit({ type: "agent_start", system, toolNames: tools.map((t) => t.name) });

  const end = (step: number, reason: AgentStopReason, finalText: string): AgentResult => {
    emit({ type: "agent_end", step, reason, usage });
    return { messages, stopReason: reason, steps: step, usage, finalText };
  };

  let step = 0;
  let warnedTokenBudget = false;
  try {
    for (;;) {
      step += 1;
      emit({ type: "turn_start", step });

      const response = await completeWithChildSignal(
        provider,
        {
          model,
          system,
          messages: keepRecentToolResults > 0 ? pruneToolResults(messages, keepRecentToolResults) : messages,
          tools: toolSchemas,
          maxTokens: maxTokensPerCall,
          temperature,
        },
        signal,
      );

      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;

      emit({ type: "assistant_message", step, content: response.content, usage: response.usage });
      messages.push({ role: "assistant", content: response.content });

      const toolUses = toolUsesOf(response.content);

      if (toolUses.length === 0) {
        const finalText = textOf(response.content);
        // The task contract's fail-closed exit: the model reports an unreachable goal or
        // ungrounded required data instead of substituting or fabricating (#20, #21).
        if (/^\s*BLOCKED:/i.test(finalText)) return end(step, "blocked", finalText);
        return end(step, "done", finalText);
      }

      const resultBlocks: ToolResultBlock[] = [];
      for (const use of toolUses) {
        const tool = toolByName.get(use.name);
        emit({ type: "tool_start", step, toolUseId: use.id, name: use.name, input: use.input });
        const started = Date.now();

        let result;
        if (!tool) {
          result = { content: `Unknown tool: ${use.name}`, isError: true };
        } else {
          result = await guard.run(step, tool, use.input, { signal: toolSignal, emit });
        }

        emit({ type: "tool_end", step, toolUseId: use.id, name: use.name, result, ms: Date.now() - started });
        resultBlocks.push({
          type: "tool_result",
          toolUseId: use.id,
          content: result.content,
          isError: result.isError,
        });
      }
      messages.push({ role: "user", content: resultBlocks });

      // Circuit breakers, checked after each completed step.
      if (step >= maxSteps) {
        emit({ type: "guard", step, reason: "max_steps", detail: `reached ${maxSteps} steps` });
        return end(step, "max_steps", "");
      }
      if (maxTokens !== undefined && usage.outputTokens >= maxTokens) {
        emit({ type: "guard", step, reason: "max_tokens", detail: `output tokens ${usage.outputTokens} >= ${maxTokens}` });
        return end(step, "max_tokens", "");
      }
      const totalTokens = usage.inputTokens + usage.outputTokens;
      if (maxTotalTokens !== undefined && !warnedTokenBudget && totalTokens >= maxTotalTokens * 0.8 && totalTokens < maxTotalTokens) {
        warnedTokenBudget = true;
        emit({ type: "log", level: "warn", message: `token budget 80% used: ${totalTokens} of ${maxTotalTokens}` });
      }
      if (maxTotalTokens !== undefined && totalTokens >= maxTotalTokens) {
        emit({ type: "guard", step, reason: "max_tokens", detail: `total tokens ${totalTokens} >= ${maxTotalTokens}` });
        return end(step, "max_tokens", "");
      }
      if (signal?.aborted) {
        emit({ type: "guard", step, reason: "aborted", detail: "signal aborted" });
        return end(step, "aborted", "");
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: "log", level: "error", message: "runAgent error: " + msg });
    return end(step, "error", msg);
  }
}
