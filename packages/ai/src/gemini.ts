import { GoogleGenAI, type Content, type FunctionDeclaration, type GenerateContentResponse, type Part, type Tool } from "@google/genai";
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
          const partObj: Record<string, unknown> = {
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.input,
            },
          };
          if (block.thoughtSignature) {
            partObj.thoughtSignature = block.thoughtSignature;
          }
          parts.push(partObj as unknown as Part);
          break;
        }
        case "tool_result": {
          const toolName = toolNameMap.get(block.toolUseId) || block.toolUseId;
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
  for (const part of parts) {
    if (part.text !== undefined) {
      out.push({ type: "text", text: part.text });
    }
    if (part.functionCall) {
      const p = part as { thoughtSignature?: string; functionCall: { id?: string; name?: string; args?: Record<string, unknown> } };
      out.push({
        type: "tool_use",
        id: part.functionCall.id || part.functionCall.name || "call",
        name: part.functionCall.name || "",
        input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
      });
    }
  }
  return out;
}

export function fromGeminiResponse(
  res: GenerateContentResponse,
  fallbackModel = "gemini-3.6-flash",
): CompletionResponse {
  const candidate = res.candidates?.[0];
  const content = fromGeminiContent(candidate?.content?.parts);
  const hasToolUse = content.some((b) => b.type === "tool_use");
  const stopReason = mapGeminiFinishReason(candidate?.finishReason, hasToolUse);

  return {
    content,
    stopReason,
    usage: {
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
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
      ...(opts.baseURL ? { apiEndpoint: opts.baseURL } : {}),
    });
    this.defaultModel = opts.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = req.model ?? this.defaultModel ?? "gemini-3.6-flash";
    const contents = toGeminiContents(req.messages);

    const config: Record<string, unknown> = {};
    if (req.system !== undefined) config.systemInstruction = req.system;
    if (req.temperature !== undefined) config.temperature = req.temperature;
    config.maxOutputTokens = req.maxTokens ?? 4096;
    if (req.tools && req.tools.length > 0) config.tools = toGeminiTools(req.tools);
    if (req.signal) config.abortSignal = req.signal;

    const maxRetries = 4;
    const baseDelayMs = 5_000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.client.models.generateContent({ model, contents, config });
        return fromGeminiResponse(res, model);
      } catch (err) {
        // Never swallow cancellation.
        if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
          throw err;
        }

        const status = (err as { status?: number } | undefined)?.status;

        // Retry on 429 (rate-limit) with exponential back-off.
        if (status === 429 && attempt < maxRetries) {
          const delayMs = baseDelayMs * 2 ** attempt; // 5s, 10s, 20s, 40s
          console.error(
            `[gemini] rate-limited (429) — retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})…`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw wrapProviderError("gemini", "GEMINI_API_KEY", model, err);
      }
    }

    // unreachable — loop always returns or throws
    /* c8 ignore next */
    throw new Error("unreachable");
  }
}
