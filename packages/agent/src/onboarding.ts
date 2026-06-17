import * as p from "@clack/prompts";
import { validateKey, PixelpiProviderError, type ProviderKind } from "@josharsh/pixelpi-ai";
import {
  loadConfig,
  saveConfig,
  resolveSettings,
  configPath,
  ENV_VAR,
  type PixelpiConfig,
  type SettingsFlags,
  type ResolvedSettings,
} from "./config";

const LABEL: Record<ProviderKind, string> = { anthropic: "Anthropic", openai: "OpenAI" };
const KEY_URL: Record<ProviderKind, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
};
const MODELS: Record<ProviderKind, { value: string; label: string; hint?: string }[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6", hint: "recommended" },
    { value: "claude-opus-4-1", label: "claude-opus-4-1", hint: "most capable" },
  ],
  openai: [
    { value: "gpt-4o", label: "gpt-4o", hint: "recommended" },
    { value: "gpt-4o-mini", label: "gpt-4o-mini", hint: "cheap & fast" },
  ],
};

/** Narrow away clack's cancel symbol, exiting cleanly if the user pressed Ctrl-C. */
function unlessCancelled<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled — run `pixelpi` again when you're ready.");
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}

/** If exactly one provider key is in the environment, pre-select that provider. */
function detectProvider(): ProviderKind | undefined {
  const a = (process.env.ANTHROPIC_API_KEY ?? "").trim() !== "";
  const o = (process.env.OPENAI_API_KEY ?? "").trim() !== "";
  if (a && !o) return "anthropic";
  if (o && !a) return "openai";
  return undefined;
}

/** The guided first-run wizard. Validates the key before persisting. Returns the saved config. */
export async function runOnboarding(): Promise<PixelpiConfig> {
  const existing = loadConfig();

  p.intro("pixelpi · a tiny browser agent");
  p.log.message(
    "Six tools, a real Chrome, your task. Let's get you a key first.\n(~30 seconds — the only setup screen you'll see.)",
  );

  const provider = unlessCancelled(
    await p.select({
      message: "Provider",
      initialValue: existing.provider ?? detectProvider() ?? "anthropic",
      options: [
        { value: "anthropic" as const, label: "Anthropic", hint: "Claude — recommended" },
        { value: "openai" as const, label: "OpenAI", hint: "GPT" },
      ],
    }),
  );

  const envKey = (process.env[ENV_VAR[provider]] ?? "").trim();
  let key = envKey;
  if (envKey) {
    p.log.info(`Found ${ENV_VAR[provider]} in your environment — using it.`);
  } else {
    p.log.message(`Get a key at ${KEY_URL[provider]}`);
    key = unlessCancelled(
      await p.password({
        message: `Paste your ${LABEL[provider]} API key`,
        validate: (v) => (v && v.trim() ? undefined : "A key is required"),
      }),
    ).trim();
  }

  let model = unlessCancelled(
    await p.select({
      message: "Default model",
      initialValue: MODELS[provider][0]!.value,
      options: [...MODELS[provider], { value: "__other__", label: "other…", hint: "type any model id" }],
    }),
  );
  if (model === "__other__") {
    model = unlessCancelled(
      await p.text({
        message: "Model id",
        placeholder: MODELS[provider][0]!.value,
        validate: (v) => (v && v.trim() ? undefined : "A model id is required"),
      }),
    ).trim();
  }

  const spin = p.spinner();
  spin.start("Checking key…");
  try {
    await validateKey({ provider, model, apiKey: key });
    spin.stop("Key valid ✓");
  } catch (err) {
    spin.stop("Key check failed ✗");
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Run `pixelpi auth` to try again.");
    process.exit(1);
  }

  const config: PixelpiConfig = {
    ...existing,
    provider,
    model,
    headless: existing.headless ?? true,
    storePath: existing.storePath ?? ".pixelpi-store.json",
  };
  // Persist a pasted key; a key that came from the environment stays in the environment.
  if (!envKey) config.apiKey = key;
  saveConfig(config);

  p.note(
    `try:  go to news.ycombinator.com and tell me the top story`,
    `Saved to ${configPath()}${config.apiKey ? "  (key stored 0600, owner-only)" : ""}`,
  );
  p.outro("You're set.");
  return config;
}

/**
 * Ensure we have a usable key. If configured → return settings. If not and interactive →
 * run onboarding. If not and non-interactive → throw a CI-friendly error.
 */
export async function ensureConfigured(
  flags: SettingsFlags,
  interactive: boolean,
): Promise<ResolvedSettings> {
  let config = loadConfig();
  let settings = resolveSettings(flags, config);
  if (settings.keySource === "none") {
    if (!interactive) {
      throw new PixelpiProviderError(
        `No ${settings.provider} API key found. Set ${settings.envVar}, or run \`pixelpi auth\`. ` +
          `Get a key at ${KEY_URL[settings.provider]}.`,
      );
    }
    config = await runOnboarding();
    settings = resolveSettings(flags, config);
  }
  return settings;
}
