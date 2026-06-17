import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import {
  fromOpenAIMessage,
  fromOpenAIResponse,
  mapOpenAIFinishReason,
  toOpenAIMessages,
  toOpenAITools,
} from "./openai.js";

const conversation: LLMMessage[] = [
  { role: "user", content: [{ type: "text", text: "open the menu" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "clicking it" },
      { type: "tool_use", id: "tu_1", name: "act", input: { ref: 3, op: "click" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "tu_1", content: "clicked" }],
  },
];

describe("toOpenAIMessages", () => {
  it("prepends system, builds assistant tool_calls, and emits role:tool for results", () => {
    const mapped = toOpenAIMessages("be terse", conversation);
    expect(mapped[0]).toEqual({ role: "system", content: "be terse" });
    expect(mapped[1]).toEqual({ role: "user", content: "open the menu" });
    expect(mapped[2]).toEqual({
      role: "assistant",
      content: "clicking it",
      tool_calls: [
        { id: "tu_1", type: "function", function: { name: "act", arguments: '{"ref":3,"op":"click"}' } },
      ],
    });
    expect(mapped[3]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "clicked" });
  });

  it("omits system when undefined", () => {
    const mapped = toOpenAIMessages(undefined, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(mapped).toEqual([{ role: "user", content: "hi" }]);
  });

  it("emits a tool-call-only assistant message with no content field", () => {
    const mapped = toOpenAIMessages(undefined, [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "look", input: {} }] },
    ]);
    expect(mapped[0]).toEqual({
      role: "assistant",
      tool_calls: [{ id: "a", type: "function", function: { name: "look", arguments: "{}" } }],
    });
    expect("content" in mapped[0]).toBe(false);
  });
});

describe("toOpenAITools", () => {
  it("wraps schema as a function tool with parameters", () => {
    const tools = toOpenAITools([
      { name: "fill", description: "type text", inputSchema: { type: "object" } },
    ]);
    expect(tools[0]).toEqual({
      type: "function",
      function: { name: "fill", description: "type text", parameters: { type: "object" } },
    });
  });
});

describe("mapOpenAIFinishReason", () => {
  it("maps reasons with stop fallback", () => {
    expect(mapOpenAIFinishReason("tool_calls")).toBe("tool_use");
    expect(mapOpenAIFinishReason("length")).toBe("max_tokens");
    expect(mapOpenAIFinishReason("stop")).toBe("end_turn");
    expect(mapOpenAIFinishReason("content_filter")).toBe("stop");
    expect(mapOpenAIFinishReason(null)).toBe("stop");
  });
});

describe("fromOpenAIMessage / fromOpenAIResponse", () => {
  it("parses tool_calls arguments into input objects and content into text", () => {
    const blocks = fromOpenAIMessage({
      content: "ok",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "nav", arguments: '{"url":"https://a"}' },
        },
      ],
    });
    expect(blocks).toEqual([
      { type: "text", text: "ok" },
      { type: "tool_use", id: "call_1", name: "nav", input: { url: "https://a" } },
    ]);
  });

  it("skips non-function tool calls and empty content", () => {
    const blocks = fromOpenAIMessage({
      content: null,
      tool_calls: [
        { id: "c", type: "custom", custom: { name: "x", input: "y" } },
        { id: "d", type: "function", function: { name: "look", arguments: "" } },
      ] as unknown as Parameters<typeof fromOpenAIMessage>[0]["tool_calls"],
    });
    expect(blocks).toEqual([{ type: "tool_use", id: "d", name: "look", input: {} }]);
  });

  it("maps a full response with usage and finish_reason", () => {
    const fixture = {
      id: "chatcmpl_1",
      model: "gpt-x",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_9", type: "function", function: { name: "act", arguments: '{"ref":2}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
    } as unknown as Parameters<typeof fromOpenAIResponse>[0];

    const res = fromOpenAIResponse(fixture);
    expect(res.content).toEqual([{ type: "tool_use", id: "call_9", name: "act", input: { ref: 2 } }]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 4 });
    expect(res.model).toBe("gpt-x");
  });
});
