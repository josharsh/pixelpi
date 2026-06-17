import { describe, it, expect, afterEach } from "vitest";
import { PixelpiProviderError, resolveApiKey, wrapProviderError } from "./errors.js";

describe("resolveApiKey", () => {
  const orig = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = orig;
  });

  it("returns an explicit key", () => {
    expect(resolveApiKey("anthropic", "sk-explicit", "ANTHROPIC_API_KEY")).toBe("sk-explicit");
  });

  it("falls back to the env var and trims it", () => {
    process.env.ANTHROPIC_API_KEY = "  sk-env  ";
    expect(resolveApiKey("anthropic", undefined, "ANTHROPIC_API_KEY")).toBe("sk-env");
  });

  it("throws an actionable error for an empty string (the common .env mistake)", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(() => resolveApiKey("anthropic", undefined, "ANTHROPIC_API_KEY")).toThrow(PixelpiProviderError);
    try {
      resolveApiKey("anthropic", "", "ANTHROPIC_API_KEY");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("ANTHROPIC_API_KEY");
      expect(msg).toContain(".env");
      expect(msg).toContain("console.anthropic.com");
    }
  });

  it("throws for a whitespace-only key", () => {
    expect(() => resolveApiKey("openai", "   ", "OPENAI_API_KEY")).toThrow(/No openai API key/);
  });
});

describe("wrapProviderError", () => {
  const wrap = (status?: number, extra: Record<string, unknown> = {}) =>
    wrapProviderError("anthropic", "ANTHROPIC_API_KEY", "claude-x", { status, ...extra }) as Error;

  it("maps 401/403 to an auth message naming the env var", () => {
    expect(wrap(401).message).toMatch(/rejected.*HTTP 401.*ANTHROPIC_API_KEY/s);
    expect(wrap(403).message).toContain("HTTP 403");
  });

  it("maps 429 to rate-limit guidance", () => {
    expect(wrap(429).message).toMatch(/rate limit or quota/);
  });

  it("maps 404 to a model-not-found message naming the model", () => {
    expect(wrap(404).message).toMatch(/claude-x.*HTTP 404/s);
  });

  it("passes abort errors through unchanged (so the loop can handle cancellation)", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(wrapProviderError("openai", "OPENAI_API_KEY", "gpt", abort)).toBe(abort);
  });

  it("wraps unknown errors but keeps the original message", () => {
    const e = wrapProviderError("openai", "OPENAI_API_KEY", "gpt", new Error("kaboom")) as Error;
    expect(e).toBeInstanceOf(PixelpiProviderError);
    expect(e.message).toMatch(/\[openai\].*kaboom/);
  });
});
