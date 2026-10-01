import { GoogleGenAI, type Content, type FunctionDeclaration, type GenerateContentResponse, type Part, type Tool } from "@google/genai";
import { PixelpiProviderError, resolveApiKey, wrapProviderError } from "./errors.js";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LLMMessage,
  LLMProvider,
  StopReason,
  ToolSchema,
} from "./types.js";

/** Map our conversation to Gemini Content objects. */
export function toGeminiContents(messages: LLMMessage[]): Content[] {
  // Build a lookup map of toolUseId -> tool name from assistant messages
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        toolNameMap.set(block.id, block.name);
      }
    }
  }

  const contents: Content[] = [];

  for (const msg of messages) {
    const parts: Part[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          if (block.text !== undefined) parts.push({ text: block.text });
          break;
        case "tool_use": {
          parts.push({
            functionCall: { id: block.id, name: block.name, args: block.input },
            ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
          });
          break;
        }
        case "tool_result": {
          const toolName = toolNameMap.get(block.toolUseId);
          if (!toolName) {
            throw new PixelpiProviderError(
              `tool_result references unknown tool_use id "${block.toolUseId}"; Gemini needs the function name.`,
            );
          }
          parts.push({
            functionResponse: {
              id: block.toolUseId,
              name: toolName,
              response: {
                output: block.content,
                ...(block.isError ? { isError: true } : {}),
              },
            },
          });
          break;
        }
      }
    }

    if (parts.length === 0) continue;

    // In Gemini, functionResponse blocks must be delivered under the "user" role.
    const hasToolResult = msg.content.some((b) => b.type === "tool_result");
    const role = hasToolResult ? "user" : msg.role === "assistant" ? "model" : "user";
    contents.push({ role, parts });
  }

  return contents;
}

export function toGeminiTools(tools: ToolSchema[]): Tool[] {
  const functionDeclarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.inputSchema,
  }));
  return [{ functionDeclarations }];
}

export function mapGeminiFinishReason(reason?: string | null, hasToolUse?: boolean): StopReason {
  if (hasToolUse) return "tool_use";
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      return "stop";
  }
}

export function fromGeminiContent(parts?: Part[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (!parts) return out;
  parts.forEach((part, index) => {
    // Thinking models emit `thought: true` parts that also carry text; they are not the answer.
    if (part.text !== undefined && !part.thought) {
      out.push({ type: "text", text: part.text });
    }
    if (part.functionCall) {
      const name = part.functionCall.name || "";
      out.push({
        type: "tool_use",
        // `id` is optional in the API; fall back to something unique so parallel calls stay distinct.
        id: part.functionCall.id || `${name || "call"}_${index}`,
        name,
        input: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      });
    }
  });
  return out;
}

export function fromGeminiResponse(
  res: GenerateContentResponse,
  fallbackModel = "",
): CompletionResponse {
  const candidate = res.candidates?.[0];
  if (!candidate && res.promptFeedback?.blockReason) {
    throw new PixelpiProviderError(
      `Gemini blocked the prompt (${res.promptFeedback.blockReason})` +
        (res.promptFeedback.blockReasonMessage ? `: ${res.promptFeedback.blockReasonMessage}` : "."),
    );
  }
  const content = fromGeminiContent(candidate?.content?.parts);
  const hasToolUse = content.some((b) => b.type === "tool_use");
  const stopReason = mapGeminiFinishReason(candidate?.finishReason, hasToolUse);

  return {
    content,
    stopReason,
    usage: {
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      // Thinking tokens are billed as output but excluded from candidatesTokenCount.
      outputTokens:
        (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
    },
    model: res.modelVersion || fallbackModel,
  };
}

export class GeminiProvider implements LLMProvider {
  readonly id = "gemini";
  private client: GoogleGenAI;
  private defaultModel?: string;

  constructor(opts: { apiKey?: string; baseURL?: string; model?: string } = {}) {
    // Fail fast with a clear message if the key is missing (before any network call / Chrome launch).
    const apiKey = resolveApiKey("gemini", opts.apiKey, "GEMINI_API_KEY");
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        ...(opts.baseURL ? { baseUrl: opts.baseURL } : {}),
        // Match the Anthropic/OpenAI SDK defaults (2 retries). `attempts` counts the first call.
        // Short maxDelay (seconds) keeps Ctrl-C responsive between attempts.
        retryOptions: { attempts: 3, maxDelay: 5 },
      },
    });
    this.defaultModel = opts.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = req.model ?? this.defaultModel ?? "";
    const contents = toGeminiContents(req.messages);

    const config: Record<string, unknown> = {};
    if (req.system !== undefined) config.systemInstruction = req.system;
    if (req.temperature !== undefined) config.temperature = req.temperature;
    config.maxOutputTokens = req.maxTokens ?? 4096;
    if (req.tools && req.tools.length > 0) config.tools = toGeminiTools(req.tools);
    if (req.signal) config.abortSignal = req.signal;

    try {
      const res = await this.client.models.generateContent({ model, contents, config });
      return fromGeminiResponse(res, model);
    } catch (err) {
      // Never swallow cancellation.
      if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
        throw err;
      }
      if (err instanceof PixelpiProviderError) throw err;
      throw wrapProviderError("gemini", "GEMINI_API_KEY", model, err);
    }
  }
}
