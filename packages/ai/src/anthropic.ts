import Anthropic from "@anthropic-ai/sdk";
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

type AnthMessageParam = Anthropic.MessageCreateParams["messages"][number];
type AnthBlockParam = Exclude<AnthMessageParam["content"], string>[number];
type AnthTool = Anthropic.Tool;

/** Map our conversation to Anthropic message params. tool_result blocks always ride on a user message. */
export function toAnthropicMessages(messages: LLMMessage[]): AnthMessageParam[] {
  return messages.map((msg) => {
    const content: AnthBlockParam[] = msg.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "tool_use":
          return { type: "tool_use", id: block.id, name: block.name, input: block.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
      }
    });
    // tool_result blocks must be delivered on a user turn.
    const role: "user" | "assistant" = msg.content.some((b) => b.type === "tool_result")
      ? "user"
      : msg.role;
    return { role, content };
  });
}

export function toAnthropicTools(tools: ToolSchema[]): AnthTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as AnthTool["input_schema"],
  }));
}

export function mapAnthropicStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "stop";
  }
}

export function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return out;
}

export function fromAnthropicResponse(msg: Anthropic.Message): CompletionResponse {
  return {
    content: fromAnthropicContent(msg.content),
    stopReason: mapAnthropicStopReason(msg.stop_reason),
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
    },
    model: msg.model,
  };
}

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  private client: Anthropic;
  private defaultModel?: string;

  constructor(opts: { apiKey?: string; baseURL?: string; model?: string } = {}) {
    // Fail fast with a clear message if the key is missing (before any network call / Chrome launch).
    const apiKey = resolveApiKey("anthropic", opts.apiKey, "ANTHROPIC_API_KEY");
    this.client = new Anthropic({ apiKey, baseURL: opts.baseURL });
    this.defaultModel = opts.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = req.model ?? this.defaultModel ?? "";
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxTokens ?? 4096,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.system !== undefined) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) body.tools = toAnthropicTools(req.tools);

    try {
      const res = await this.client.messages.create(body, { signal: req.signal });
      return fromAnthropicResponse(res);
    } catch (err) {
      throw wrapProviderError("anthropic", "ANTHROPIC_API_KEY", model, err);
    }
  }
}
