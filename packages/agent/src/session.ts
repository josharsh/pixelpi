import { createProvider } from "@josharsh/pixelpi-ai";
import { runAgent, JsonFileStore } from "@josharsh/pixelpi-core";
import type { LLMProvider, ProviderKind } from "@josharsh/pixelpi-ai";
import type { AgentEvent, AgentResult, LLMMessage, Store, Tool, Usage } from "@josharsh/pixelpi-core";
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import type { CdpSession, PendingAction, Skill } from "@josharsh/pixelpi-cdp";
import { buildSystemPrompt } from "./prompt";
import type { ResolvedSettings } from "./config";
import type { PixelpiSession, PixelpiSessionOptions } from "./types";

/** Collect the one-line descriptions of installed skills, for the system prompt and /skills. */
export async function readSkillDescriptions(store: Store): Promise<string[]> {
  const keys = await store.list("skills/");
  const descriptions: string[] = [];
  for (const key of keys) {
    const skill = (await store.get(key)) as Skill | undefined;
    if (skill && typeof skill.description === "string") descriptions.push(skill.description);
  }
  return descriptions;
}

/** A long-lived session: one Chrome, one conversation, reused across turns (the REPL's backbone). */
export interface InteractiveSession {
  /** Run one task on the persistent conversation + browser. Launches Chrome lazily on first call. */
  send(task: string, signal?: AbortSignal): Promise<AgentResult>;
  /** Drop the conversation and the browser; the next send() starts fresh. */
  reset(): Promise<void>;
  /** Rebuild the provider (e.g. /model, /provider) keeping the conversation and browser. */
  applyProvider(spec: { provider: ProviderKind; model: string; apiKey?: string }): void;
  /** Headless preference for the NEXT Chrome launch. */
  setHeadless(headless: boolean): void;
  chromeRunning(): boolean;
  messageCount(): number;
  usage(): Usage;
  readonly store: Store;
  close(): Promise<void>;
}

export interface PixelpiSessionInit {
  settings: ResolvedSettings;
  store?: Store;
  maxSteps?: number;
  /** Circuit breaker: cumulative input+output token budget for a run. */
  maxTotalTokens?: number;
  /** Navigation allowlist enforced at the tool layer (hosts + their subdomains). */
  allowDomains?: string[];
  /** Withhold consequential actions (submit/send/purchase) instead of performing them. */
  dryRun?: boolean;
  /** Ask before each consequential action; false/absent resolution withholds it. */
  confirmAction?: (action: PendingAction) => Promise<boolean>;
  onEvent?: (event: AgentEvent) => void;
}

export function createPixelpiSession(init: PixelpiSessionInit): InteractiveSession {
  let model = init.settings.model;
  let apiKey = init.settings.apiKey;
  let headless = init.settings.headless;
  const profileDir = init.settings.profileDir;
  let provider: LLMProvider = createProvider({
    provider: init.settings.provider,
    model,
    apiKey,
  });

  const store: Store = init.store ?? new JsonFileStore(init.settings.storePath);
  let messages: LLMMessage[] = [];
  let usageTotal: Usage = { inputTokens: 0, outputTokens: 0 };
  let chrome: { session: CdpSession; close: () => Promise<void> } | undefined;
  let tools: Tool[] = [];
  let system = "";

  async function ensureChrome(): Promise<void> {
    if (chrome) return;
    const launched = await launchChrome({ headless, userDataDir: profileDir });
    chrome = { session: launched.session, close: launched.close };
    tools = createBrowserTools({
      session: launched.session,
      store,
      allowDomains: init.allowDomains,
      dryRun: init.dryRun,
      confirmAction: init.confirmAction,
    });
    system = buildSystemPrompt({
      skillDescriptions: await readSkillDescriptions(store),
      allowDomains: init.allowDomains,
      dryRun: init.dryRun,
    });
  }

  return {
    store,

    async send(task, signal) {
      await ensureChrome();
      messages.push({ role: "user", content: [{ type: "text", text: task }] });
      const result = await runAgent({
        provider,
        model,
        system,
        tools,
        messages,
        maxSteps: init.maxSteps,
        maxTotalTokens: init.maxTotalTokens,
        signal,
        onEvent: init.onEvent,
      });
      messages = result.messages;
      usageTotal = {
        inputTokens: usageTotal.inputTokens + result.usage.inputTokens,
        outputTokens: usageTotal.outputTokens + result.usage.outputTokens,
      };
      return result;
    },

    async reset() {
      messages = [];
      if (chrome) {
        await chrome.close();
        chrome = undefined;
        tools = [];
        system = "";
      }
    },

    applyProvider(spec) {
      model = spec.model;
      apiKey = spec.apiKey;
      provider = createProvider({ provider: spec.provider, model, apiKey });
    },

    setHeadless(value) {
      headless = value;
    },

    chromeRunning: () => chrome !== undefined,
    messageCount: () => messages.length,
    usage: () => usageTotal,

    async close() {
      if (chrome) await chrome.close();
      chrome = undefined;
    },
  };
}

/**
 * One-shot session (the original public API): seed a single task, run it once, close.
 * Implemented as a thin wrapper over createPixelpiSession so the loop logic lives in one place.
 */
export async function createBrowserAgentSession(opts: PixelpiSessionOptions): Promise<PixelpiSession> {
  const spec = opts.model ?? {
    provider: "anthropic" as const,
    model: process.env.PIXELPI_MODEL || "claude-sonnet-4-6",
  };
  const settings: ResolvedSettings = {
    provider: spec.provider,
    model: spec.model,
    headless: opts.launch?.headless ?? true,
    storePath: opts.storePath ?? ".pixelpi-store.json",
    apiKey: spec.apiKey,
    keySource: spec.apiKey ? "config" : "none",
    envVar: spec.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
  };
  const session = createPixelpiSession({
    settings,
    store: opts.store,
    maxSteps: opts.maxSteps,
    maxTotalTokens: opts.maxTotalTokens,
    allowDomains: opts.allowDomains,
    dryRun: opts.dryRun,
    confirmAction: opts.confirmAction,
    onEvent: opts.onEvent,
  });
  return {
    run: () => session.send(opts.task),
    close: () => session.close(),
  };
}
