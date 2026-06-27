export * from "./types";
export { createBrowserAgentSession, createPixelpiSession, readSkillDescriptions } from "./session";
export type { InteractiveSession, PixelpiSessionInit } from "./session";
export { buildSystemPrompt } from "./prompt";
export { renderEvent, setColorEnabled } from "./render";
export { startRepl } from "./repl";
export { runOnboarding, ensureConfigured } from "./onboarding";
export {
  loadConfig,
  saveConfig,
  configDir,
  configPath,
  resolveSettings,
  resolveCredential,
  DEFAULT_MODEL,
} from "./config";
export type { PixelpiConfig, ResolvedSettings, SettingsFlags, KeySource } from "./config";

// Traces as functions: load a recorded trace and call it with params, or map it over a dataset.
export { loadTrace } from "./sdk";
export type { CallableTrace, RunOnceResult, CallOptions, OverOptions, LoadOptions } from "./sdk";
export { replayTrace } from "./replay";
export type { ReplayResult, ReplayStep } from "./replay";
export { run } from "./run";
export type { RowOutcome, RunSummary, RunOptions } from "./run";
export { describeTrace, defaultOutput } from "./trace";
export type { Trace, TraceStep, TraceParam, Target, TraceDescription, OutputSpec } from "./trace";
