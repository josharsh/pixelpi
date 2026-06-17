import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { ProviderKind } from "@josharsh/pixelpi-ai";

export const DEFAULT_MODEL: Record<ProviderKind, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
};

export const ENV_VAR: Record<ProviderKind, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** Persisted config (see ~/.config/pixelpi/config.json). All fields optional — defaults fill the gaps. */
export interface PixelpiConfig {
  provider?: ProviderKind;
  model?: string;
  headless?: boolean;
  storePath?: string;
  /** Stored in the 0600 config file for v1 (keychain is a documented later opt-in). */
  apiKey?: string;
}

/** Flags parsed from argv that can override config. */
export interface SettingsFlags {
  provider?: ProviderKind;
  model?: string;
  headless?: boolean;
  store?: string;
}

export type KeySource = "env" | "config" | "none";

export interface ResolvedSettings {
  provider: ProviderKind;
  model: string;
  headless: boolean;
  storePath: string;
  apiKey?: string;
  keySource: KeySource;
  /** The env var consulted for this provider (for /status + error messages). */
  envVar: string;
}

export function configDir(): string {
  if (process.env.PIXELPI_CONFIG_DIR) return process.env.PIXELPI_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "pixelpi");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): PixelpiConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as PixelpiConfig;
  } catch {
    return {}; // missing or unreadable → treat as unconfigured
  }
}

export function saveConfig(config: PixelpiConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
  try {
    chmodSync(file, 0o600); // owner-only — the file holds the API key
  } catch {
    // chmod is a no-op on some platforms (e.g. Windows); acceptable.
  }
}

/**
 * Resolve the API key for a provider. Env var wins over the config file — but we
 * record the source so /status can SAY which one is in use (no silent overrides).
 */
export function resolveCredential(
  provider: ProviderKind,
  config: PixelpiConfig,
): { key?: string; source: KeySource; envVar: string } {
  const envVar = ENV_VAR[provider];
  const envKey = (process.env[envVar] ?? "").trim();
  if (envKey) return { key: envKey, source: "env", envVar };
  const configProvider = config.provider ?? "anthropic";
  if (config.apiKey && configProvider === provider) {
    return { key: config.apiKey, source: "config", envVar };
  }
  return { source: "none", envVar };
}

/** Merge flags > PIXELPI_* env > config > defaults into the settings a session needs. */
export function resolveSettings(flags: SettingsFlags, config: PixelpiConfig): ResolvedSettings {
  const provider: ProviderKind = flags.provider ?? config.provider ?? "anthropic";
  const model =
    flags.model ?? process.env.PIXELPI_MODEL ?? config.model ?? DEFAULT_MODEL[provider];
  const headless = flags.headless ?? config.headless ?? true;
  const storePath = flags.store ?? config.storePath ?? ".pixelpi-store.json";
  const cred = resolveCredential(provider, config);
  return {
    provider,
    model,
    headless,
    storePath,
    apiKey: cred.key,
    keySource: cred.source,
    envVar: cred.envVar,
  };
}
