// @josharsh/pixelpi-ai — frozen cross-package contract.
// Provider-agnostic LLM types. Anthropic/OpenAI adapters normalize to these shapes.

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** A message in the provider-agnostic conversation. `system` is passed separately on the request. */
export interface LLMMessage {
  role: Role;
  content: ContentBlock[];
}

/** Tool advertised to the model. `inputSchema` is a JSON Schema object. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: LLMMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop";

export interface CompletionResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
}

/**
 * The single seam over every model vendor. Implementations wrap a raw vendor SDK
 * and translate to/from the block shapes above. Keep this thin — no retries,
 * no agent logic; that lives in @josharsh/pixelpi-core.
 */
export interface LLMProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export type ProviderKind = "anthropic" | "openai";

/** Declarative model selection. `model` is the vendor model id. */
export interface ModelSpec {
  provider: ProviderKind;
  model: string;
  apiKey?: string;
  baseURL?: string;
}
