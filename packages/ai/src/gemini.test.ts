import { describe, expect, it } from "vitest";
import { PixelpiProviderError } from "./errors.js";
import type { LLMMessage } from "./types.js";
import {
  GeminiProvider,
  fromGeminiContent,
  fromGeminiResponse,
  mapGeminiFinishReason,
  toGeminiContents,
  toGeminiTools,
} from "./gemini.js";

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

describe("toGeminiContents", () => {
  it("maps user, model with functionCall, and user with functionResponse", () => {
    const mapped = toGeminiContents(conversation);
    expect(mapped[0]).toEqual({
      role: "user",
      parts: [{ text: "open the menu" }],
    });
    expect(mapped[1]).toEqual({
      role: "model",
      parts: [
        { text: "clicking it" },
        { functionCall: { id: "tu_1", name: "act", args: { ref: 3, op: "click" } } },
      ],
    });
    expect(mapped[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "tu_1",
            name: "act",
            response: { output: "clicked" },
          },
        },
      ],
    });
  });

  it("handles isError on tool_result", () => {
    const mapped = toGeminiContents([
      { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "act", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "tu_2", content: "failed", isError: true }],
      },
    ]);
    expect(mapped[1]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "tu_2",
            name: "act",
            response: { output: "failed", isError: true },
          },
        },
      ],
    });
  });

  it("throws on a tool_result with no matching tool_use", () => {
    expect(() =>
      toGeminiContents([
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "ghost", content: "x", isError: false }],
        },
      ]),
    ).toThrow(PixelpiProviderError);
  });

  it("round-trips thoughtSignature on tool_use", () => {
    const mapped = toGeminiContents([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "act", input: {}, thoughtSignature: "sig" }],
      },
    ]);
    expect(mapped[0]?.parts?.[0]).toMatchObject({ thoughtSignature: "sig" });
  });

  it("skips messages with empty parts", () => {
    const mapped = toGeminiContents([{ role: "user", content: [] }]);
    expect(mapped).toEqual([]);
  });
});

describe("toGeminiTools", () => {
  it("wraps tool schemas into functionDeclarations", () => {
    const tools = toGeminiTools([
      { name: "look", description: "snapshot", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "look",
            description: "snapshot",
            parametersJsonSchema: { type: "object", properties: {} },
          },
        ],
      },
    ]);
  });
});

describe("mapGeminiFinishReason", () => {
  it("prioritizes tool_use when function call is present", () => {
    expect(mapGeminiFinishReason("STOP", true)).toBe("tool_use");
    expect(mapGeminiFinishReason(undefined, true)).toBe("tool_use");
  });

  it("maps standard Gemini finish reasons", () => {
    expect(mapGeminiFinishReason("STOP", false)).toBe("end_turn");
    expect(mapGeminiFinishReason("MAX_TOKENS", false)).toBe("max_tokens");
    expect(mapGeminiFinishReason("SAFETY", false)).toBe("stop");
    expect(mapGeminiFinishReason("RECITATION", false)).toBe("stop");
    expect(mapGeminiFinishReason(null, false)).toBe("stop");
  });
});

describe("fromGeminiContent / fromGeminiResponse", () => {
  it("parses text and functionCall parts", () => {
    const blocks = fromGeminiContent([
      { text: "navigating now" },
      { functionCall: { id: "call_1", name: "nav", args: { url: "https://example.com" } } },
    ]);
    expect(blocks).toEqual([
      { type: "text", text: "navigating now" },
      { type: "tool_use", id: "call_1", name: "nav", input: { url: "https://example.com" } },
    ]);
  });

  it("drops thought parts and keeps thoughtSignature on function calls", () => {
    const blocks = fromGeminiContent([
      { text: "let me think", thought: true },
      { functionCall: { id: "c", name: "act", args: {} }, thoughtSignature: "sig" },
    ]);
    expect(blocks).toEqual([
      { type: "tool_use", id: "c", name: "act", input: {}, thoughtSignature: "sig" },
    ]);
  });

  it("gives parallel calls without ids distinct ids", () => {
    const blocks = fromGeminiContent([
      { functionCall: { name: "act", args: {} } },
      { functionCall: { name: "act", args: {} } },
    ]);
    const ids = blocks.map((b) => (b.type === "tool_use" ? b.id : ""));
    expect(new Set(ids).size).toBe(2);
  });

  it("throws a provider error when the prompt is blocked", () => {
    const blocked = { promptFeedback: { blockReason: "SAFETY" } } as unknown as Parameters<
      typeof fromGeminiResponse
    >[0];
    expect(() => fromGeminiResponse(blocked)).toThrow(/SAFETY/);
  });

  it("counts thinking tokens as output", () => {
    const res = fromGeminiResponse({
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "hi" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 5 },
    } as unknown as Parameters<typeof fromGeminiResponse>[0]);
    expect(res.usage.outputTokens).toBe(7);
  });

  it("maps full GenerateContentResponse with usage and model", () => {
    const fixture = {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "act_call",
                  name: "act",
                  args: { ref: 10, op: "click" },
                },
              },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 150,
        candidatesTokenCount: 25,
      },
      modelVersion: "gemini-3.6-flash",
    } as unknown as Parameters<typeof fromGeminiResponse>[0];

    const res = fromGeminiResponse(fixture);
    expect(res.content).toEqual([
      { type: "tool_use", id: "act_call", name: "act", input: { ref: 10, op: "click" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 150, outputTokens: 25 });
    expect(res.model).toBe("gemini-3.6-flash");
  });
});

describe("GeminiProvider retries", () => {
  it("retries a 429 via the SDK and then succeeds", async () => {
    const ok = {
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "hi" }] } }],
    };
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return calls < 3
        ? new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429 })
        : new Response(JSON.stringify(ok), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const provider = new GeminiProvider({ apiKey: "k" });
      const res = await provider.complete({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
      expect(res.content).toEqual([{ type: "text", text: "hi" }]);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
