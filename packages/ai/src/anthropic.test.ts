import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import {
  fromAnthropicContent,
  fromAnthropicResponse,
  mapAnthropicStopReason,
  toAnthropicMessages,
  toAnthropicTools,
} from "./anthropic.js";

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
    content: [{ type: "tool_result", toolUseId: "tu_1", content: "clicked", isError: false }],
  },
];

describe("toAnthropicMessages", () => {
  it("maps text, tool_use, and tool_result blocks block-by-block", () => {
    const mapped = toAnthropicMessages(conversation);
    expect(mapped[0]).toEqual({ role: "user", content: [{ type: "text", text: "open the menu" }] });
    expect(mapped[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "clicking it" },
        { type: "tool_use", id: "tu_1", name: "act", input: { ref: 3, op: "click" } },
      ],
    });
    expect(mapped[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "clicked", is_error: false }],
    });
  });

  it("forces a tool_result turn onto the user role even if mislabeled assistant", () => {
    const mapped = toAnthropicMessages([
      { role: "assistant", content: [{ type: "tool_result", toolUseId: "x", content: "ok" }] },
    ]);
    expect(mapped[0].role).toBe("user");
  });
});

describe("toAnthropicTools", () => {
  it("renames inputSchema to input_schema", () => {
    const tools = toAnthropicTools([
      { name: "look", description: "snapshot", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(tools[0]).toEqual({
      name: "look",
      description: "snapshot",
      input_schema: { type: "object", properties: {} },
    });
  });
});

describe("mapAnthropicStopReason", () => {
  it("maps known reasons and falls back to stop", () => {
    expect(mapAnthropicStopReason("end_turn")).toBe("end_turn");
    expect(mapAnthropicStopReason("tool_use")).toBe("tool_use");
    expect(mapAnthropicStopReason("max_tokens")).toBe("max_tokens");
    expect(mapAnthropicStopReason("pause_turn")).toBe("stop");
    expect(mapAnthropicStopReason(null)).toBe("stop");
  });
});

describe("fromAnthropicContent / fromAnthropicResponse", () => {
  it("maps a vendor response with text + tool_use back to ContentBlock[]", () => {
    const fixture = {
      id: "msg_1",
      model: "claude-x",
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "done", citations: null },
        { type: "tool_use", id: "tu_9", name: "nav", input: { url: "https://a" } },
        { type: "thinking", thinking: "ignored", signature: "s" },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    } as unknown as Parameters<typeof fromAnthropicResponse>[0];

    const res = fromAnthropicResponse(fixture);
    expect(res.content).toEqual([
      { type: "text", text: "done" },
      { type: "tool_use", id: "tu_9", name: "nav", input: { url: "https://a" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(res.model).toBe("claude-x");
  });

  it("defaults null tool_use input to empty object", () => {
    const out = fromAnthropicContent([
      { type: "tool_use", id: "t", name: "n", input: null },
    ] as unknown as Parameters<typeof fromAnthropicContent>[0]);
    expect(out).toEqual([{ type: "tool_use", id: "t", name: "n", input: {} }]);
  });
});
