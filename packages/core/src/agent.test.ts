import { describe, it, expect } from "vitest";
import { getEventListeners } from "node:events";
import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider } from "@josharsh/pixelpi-ai";
import { runAgent } from "./agent";
import type { Tool, ToolResult } from "./types";

// A provider that returns a scripted sequence of responses, one per complete() call.
function scriptProvider(script: CompletionResponse[]): LLMProvider {
  let i = 0;
  return {
    id: "mock",
    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      const r = script[Math.min(i, script.length - 1)];
      i += 1;
      return r;
    },
  };
}

function text(s: string): ContentBlock {
  return { type: "text", text: s };
}
function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ContentBlock {
  return { type: "tool_use", id, name, input };
}
function resp(content: ContentBlock[], stopReason: CompletionResponse["stopReason"] = "end_turn"): CompletionResponse {
  return { content, stopReason, usage: { inputTokens: 10, outputTokens: 5 }, model: "mock" };
}

function mockTool(name: string, execute: Tool["execute"]): Tool {
  return { name, description: name, inputSchema: { type: "object" }, execute };
}

describe("runAgent", () => {
  it("terminates with 'done' and concatenated finalText when no tool_use", async () => {
    const provider = scriptProvider([resp([text("hello "), text("world")])]);
    const result = await runAgent({ provider, model: "m", system: "s", tools: [], messages: [] });
    expect(result.stopReason).toBe("done");
    expect(result.finalText).toBe("hello world");
    expect(result.steps).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("executes a tool, feeds result back, then terminates next turn", async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = mockTool("echo", async (input): Promise<ToolResult> => {
      calls.push(input);
      return { content: "echoed:" + String(input.v) };
    });
    const provider = scriptProvider([
      resp([toolUse("u1", "echo", { v: 42 })], "tool_use"),
      resp([text("final answer")]),
    ]);
    const result = await runAgent({ provider, model: "m", system: "s", tools: [tool], messages: [] });

    expect(calls).toEqual([{ v: 42 }]);
    expect(result.stopReason).toBe("done");
    expect(result.finalText).toBe("final answer");
    expect(result.steps).toBe(2);
    // assistant tool_use, user tool_result, assistant final
    expect(result.messages).toHaveLength(3);
    const toolResultMsg = result.messages[1];
    expect(toolResultMsg.role).toBe("user");
    const block = toolResultMsg.content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.content).toBe("echoed:42");
      expect(block.toolUseId).toBe("u1");
    }
  });

  it("retries a throwing tool then succeeds", async () => {
    let attempts = 0;
    const retries: number[] = [];
    const tool = mockTool("flaky", async (): Promise<ToolResult> => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
      return { content: "ok" };
    });
    const provider = scriptProvider([
      resp([toolUse("u1", "flaky")], "tool_use"),
      resp([text("done")]),
    ]);
    const result = await runAgent({
      provider,
      model: "m",
      system: "s",
      tools: [tool],
      messages: [],
      guards: { retryBaseMs: 1 },
      onEvent: (e) => {
        if (e.type === "tool_retry") retries.push(e.attempt);
      },
    });

    expect(attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
    const block = result.messages[1].content[0];
    if (block.type === "tool_result") {
      expect(block.content).toBe("ok");
      expect(block.isError).toBeFalsy();
    }
  });

  it("loop-detection short-circuits after threshold", async () => {
    let executions = 0;
    const tool = mockTool("bad", async (): Promise<ToolResult> => {
      executions += 1;
      return { content: "nope", isError: true };
    });
    // The model keeps asking for the identical failing call.
    const provider = scriptProvider([resp([toolUse("u", "bad", { x: 1 })], "tool_use")]);

    let guardFired = false;
    const result = await runAgent({
      provider,
      model: "m",
      system: "s",
      tools: [tool],
      messages: [],
      maxSteps: 5,
      guards: { loopThreshold: 2, maxRetries: 0 },
      onEvent: (e) => {
        if (e.type === "guard" && e.reason === "loop") guardFired = true;
      },
    });

    // step1 fail(count1), step2 fail(count2), step3 short-circuits before executing.
    expect(executions).toBe(2);
    expect(guardFired).toBe(true);
    expect(result.stopReason).toBe("max_steps");
  });

  it("does not leak abort listeners across many turns with a provided signal", async () => {
    const tool = mockTool("noop", async (): Promise<ToolResult> => ({ content: "k" }));
    const counting: LLMProvider = {
      id: "mock",
      async complete(req: CompletionRequest) {
        // Mimic the SDK/undici adding an abort listener to the per-call signal.
        if (req.signal) req.signal.addEventListener("abort", () => {});
        return resp([toolUse("u", "noop", { n: 1 })], "tool_use");
      },
    };

    const ac = new AbortController();
    const warnings: Error[] = [];
    const onWarn = (w: Error) => warnings.push(w);
    process.on("warning", onWarn);
    try {
      const result = await runAgent({
        provider: counting,
        model: "m",
        system: "s",
        tools: [tool],
        messages: [],
        maxSteps: 15,
        signal: ac.signal,
      });
      expect(result.steps).toBe(15);
      // At most one transient listener should ever sit on the parent signal.
      expect(getEventListeners(ac.signal, "abort").length).toBeLessThanOrEqual(1);
    } finally {
      process.removeListener("warning", onWarn);
    }
    expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
  });

  it("maxSteps breaker fires", async () => {
    const tool = mockTool("noop", async (): Promise<ToolResult> => ({ content: "k" }));
    // Always returns a tool_use so the loop never naturally ends.
    const provider = scriptProvider([resp([toolUse("u", "noop", { n: 1 })], "tool_use")]);
    let i = 0;
    const counting: LLMProvider = {
      id: "mock",
      async complete() {
        i += 1;
        return resp([toolUse("u" + i, "noop", { n: i })], "tool_use");
      },
    };
    void provider;
    const result = await runAgent({
      provider: counting,
      model: "m",
      system: "s",
      tools: [tool],
      messages: [],
      maxSteps: 3,
    });
    expect(result.stopReason).toBe("max_steps");
    expect(result.steps).toBe(3);
  });
});
