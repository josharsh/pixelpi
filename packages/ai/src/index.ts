export * from "./types.js";
export { PixelpiProviderError, resolveApiKey, wrapProviderError } from "./errors.js";

import type { LLMProvider, ModelSpec } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export {
  AnthropicProvider,
  toAnthropicMessages,
  toAnthropicTools,
  mapAnthropicStopReason,
  fromAnthropicContent,
  fromAnthropicResponse,
} from "./anthropic.js";

export {
  OpenAIProvider,
  toOpenAIMessages,
  toOpenAITools,
  mapOpenAIFinishReason,
  fromOpenAIMessage,
  fromOpenAIResponse,
} from "./openai.js";

export function createProvider(spec: ModelSpec): LLMProvider {
  const opts = { apiKey: spec.apiKey, baseURL: spec.baseURL, model: spec.model };
  switch (spec.provider) {
    case "anthropic":
      return new AnthropicProvider(opts);
    case "openai":
      return new OpenAIProvider(opts);
  }
}

/**
 * Cheap pre-flight: confirm the key+model actually authenticate, with a 1-token call.
 * Throws PixelpiProviderError on a missing/rejected key (reusing the same friendly mapping
 * as the agent loop). Used by onboarding to validate before persisting / before launching Chrome.
 */
export async function validateKey(spec: ModelSpec): Promise<void> {
  const provider = createProvider(spec); // throws immediately if the key is missing/empty
  await provider.complete({
    model: spec.model,
    maxTokens: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
}
