import type { ProviderKind } from "./types.js";

/** A provider error already phrased for a human. The CLI prints its message without a stack. */
export class PixelpiProviderError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PixelpiProviderError";
  }
}

const KEY_PAGE: Record<ProviderKind, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
};

/**
 * Resolve the API key from an explicit value or env var, treating empty/whitespace as missing.
 * Throws a clear, actionable error BEFORE any network call (so we fail fast, before Chrome launches).
 */
export function resolveApiKey(
  provider: ProviderKind,
  explicit: string | undefined,
  envVar: string,
): string {
  const key = (explicit ?? process.env[envVar] ?? "").trim();
  if (!key) {
    throw new PixelpiProviderError(
      `No ${provider} API key found. Set ${envVar} in your environment or .env ` +
        `(copy .env.example to .env and fill it in), or pass model.apiKey. ` +
        `Get a key at ${KEY_PAGE[provider]}.`,
    );
  }
  return key;
}

/** Translate a raw vendor SDK error into a PixelpiProviderError with an actionable message. */
export function wrapProviderError(
  provider: ProviderKind,
  envVar: string,
  model: string,
  err: unknown,
): unknown {
  // Never swallow cancellation — let the agent loop's abort handling see it.
  if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
    return err;
  }

  const status = (err as { status?: number } | undefined)?.status;
  const tag = `[${provider}]`;

  if (status === 401 || status === 403) {
    return new PixelpiProviderError(
      `${tag} API key was rejected (HTTP ${status}). Check ${envVar} in your .env — ` +
        `it may be empty, mistyped, or revoked.`,
      err,
    );
  }
  if (status === 429) {
    return new PixelpiProviderError(
      `${tag} rate limit or quota exceeded (HTTP 429). Wait and retry, or check your plan's limits.`,
      err,
    );
  }
  if (status === 404) {
    return new PixelpiProviderError(
      `${tag} model "${model}" not found or not available to your account (HTTP 404). ` +
        `Pick a different model with --model or $PIXELPI_MODEL.`,
      err,
    );
  }
  if (status === 400) {
    const detail = err instanceof Error ? err.message : String(err);
    return new PixelpiProviderError(`${tag} rejected the request (HTTP 400): ${detail}`, err);
  }
  if (err instanceof Error && err.name === "APIConnectionError") {
    return new PixelpiProviderError(
      `${tag} could not be reached (network error). Check your internet connection${
        process.env.HTTPS_PROXY ? " / proxy settings" : ""
      }.`,
      err,
    );
  }

  // Unknown — surface the original message but mark the provider.
  const msg = err instanceof Error ? err.message : String(err);
  return new PixelpiProviderError(`${tag} request failed: ${msg}`, err);
}
