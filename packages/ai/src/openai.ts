import OpenAI from "openai";
import { resolveApiKey, wrapProviderError } from "./errors.js";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LLMMessage,
  LLMProvider,
  StopReason,
  ToolSchema,
} from "./types.js";

type OAIMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OAITool = OpenAI.Chat.Completions.ChatCompletionTool;
type OAIToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

/**
 * Map our conversation to OpenAI chat messages. An assistant turn with tool_use blocks
 * becomes one assistant message carrying tool_calls; tool_result blocks become role:"tool"
 * messages, one per result.
 */
export function toOpenAIMessages(system: string | undefined, messages: LLMMessage[]): OAIMessageParam[] {
  const out: OAIMessageParam[] = [];
  if (system !== undefined) out.push({ role: "system", content: system });

  for (const msg of messages) {
    const toolResults = msg.content.filter((b) => b.type === "tool_result");
    for (const r of toolResults) {
      out.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
    }

    const textParts = msg.content.filter((b) => b.type === "text").map((b) => b.text);
    const toolUses = msg.content.filter((b) => b.type === "tool_use");

    if (msg.role === "assistant") {
      if (textParts.length === 0 && toolUses.length === 0) continue;
      const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
      };
      if (textParts.length > 0) assistant.content = textParts.join("");
      if (toolUses.length > 0) {
        assistant.tool_calls = toolUses.map((u) => ({
          id: u.id,
          type: "function",
          function: { name: u.name, arguments: JSON.stringify(u.input) },
        }));
      }
      out.push(assistant);
    } else if (textParts.length > 0) {
      out.push({ role: "user", content: textParts.join("") });
    }
  }
  return out;
}

export function toOpenAITools(tools: ToolSchema[]): OAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export function mapOpenAIFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "stop";
  }
}

export function fromOpenAIMessage(message: {
  content?: string | null;
  tool_calls?: OAIToolCall[];
}): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (message.content) out.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    let input: Record<string, unknown> = {};
    if (call.function.arguments) {
      input = JSON.parse(call.function.arguments) as Record<string, unknown>;
    }
    out.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  return out;
}

export function fromOpenAIResponse(res: OpenAI.Chat.Completions.ChatCompletion): CompletionResponse {
  const choice = res.choices[0];
  return {
    content: fromOpenAIMessage(choice.message),
    stopReason: mapOpenAIFinishReason(choice.finish_reason),
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
    },
    model: res.model,
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly id = "openai";
  private client: OpenAI;
  private defaultModel?: string;

  constructor(opts: { apiKey?: string; baseURL?: string; model?: string } = {}) {
    // Fail fast with a clear message if the key is missing (before any network call / Chrome launch).
    const apiKey = resolveApiKey("openai", opts.apiKey, "OPENAI_API_KEY");
    this.client = new OpenAI({ apiKey, baseURL: opts.baseURL });
    this.defaultModel = opts.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = req.model ?? this.defaultModel ?? "";
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: toOpenAIMessages(req.system, req.messages),
    };
    if (req.maxTokens !== undefined) body.max_completion_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) body.tools = toOpenAITools(req.tools);

    try {
      const res = await this.client.chat.completions.create(body, { signal: req.signal });
      return fromOpenAIResponse(res);
    } catch (err) {
      throw wrapProviderError("openai", "OPENAI_API_KEY", model, err);
    }
  }
}
