import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  configPath,
  resolveCredential,
  resolveSettings,
  DEFAULT_MODEL,
} from "./config";

const SAVED = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pixelpi-cfg-"));
  process.env.PIXELPI_CONFIG_DIR = dir;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.PIXELPI_MODEL;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...SAVED };
});

describe("config persistence", () => {
  it("round-trips through the config file and returns {} when missing", () => {
    expect(loadConfig()).toEqual({});
    saveConfig({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-x" });
    expect(loadConfig()).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-x" });
  });

  it("writes the key file owner-only (0600)", () => {
    saveConfig({ apiKey: "sk-secret" });
    expect(existsSync(configPath())).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    }
  });
});

describe("resolveCredential", () => {
  it("prefers the env var and reports source 'env'", () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";
    expect(resolveCredential("anthropic", { apiKey: "sk-config", provider: "anthropic" })).toEqual({
      key: "sk-env",
      source: "env",
      envVar: "ANTHROPIC_API_KEY",
    });
  });

  it("falls back to config when no env var, reporting source 'config'", () => {
    expect(resolveCredential("anthropic", { apiKey: "sk-config", provider: "anthropic" })).toMatchObject({
      key: "sk-config",
      source: "config",
    });
  });

  it("does not use a config key that belongs to a different provider", () => {
    expect(resolveCredential("openai", { apiKey: "sk-anthropic", provider: "anthropic" })).toMatchObject({
      source: "none",
    });
  });

  it("reports 'none' when nothing is set", () => {
    expect(resolveCredential("anthropic", {}).source).toBe("none");
  });
});

describe("resolveSettings precedence", () => {
  it("uses defaults when nothing is configured", () => {
    const s = resolveSettings({}, {});
    expect(s.provider).toBe("anthropic");
    expect(s.model).toBe(DEFAULT_MODEL.anthropic);
    expect(s.headless).toBe(true);
    expect(s.storePath).toBe(".pixelpi-store.json");
    expect(s.keySource).toBe("none");
  });

  it("flags beat env beat config beat default for the model", () => {
    expect(resolveSettings({ model: "flag-model" }, { model: "config-model" }).model).toBe("flag-model");
    process.env.PIXELPI_MODEL = "env-model";
    expect(resolveSettings({}, { model: "config-model" }).model).toBe("env-model");
    delete process.env.PIXELPI_MODEL;
    expect(resolveSettings({}, { model: "config-model" }).model).toBe("config-model");
  });

  it("--no-headless (headless:false) overrides a config headless:true", () => {
    expect(resolveSettings({ headless: false }, { headless: true }).headless).toBe(false);
  });

  it("picks the provider-appropriate default model when provider is switched by flag", () => {
    expect(resolveSettings({ provider: "openai" }, {}).model).toBe(DEFAULT_MODEL.openai);
  });

  it("profileDir: flag beats config, config when no flag, undefined when neither", () => {
    expect(resolveSettings({ profile: "/flag/profile" }, { profile: "/config/profile" }).profileDir).toBe(
      "/flag/profile",
    );
    expect(resolveSettings({}, { profile: "/config/profile" }).profileDir).toBe("/config/profile");
    expect(resolveSettings({}, {}).profileDir).toBeUndefined();
  });
});
