// @josharsh/pixelpi-core — frozen cross-package contract.
// The agent loop, the Tool interface, the Store interface, observability events, and guards.
// Reuses @josharsh/pixelpi-ai message types so there is one conversation representation, not two.

import type { ContentBlock, LLMMessage, LLMProvider, Usage } from "@josharsh/pixelpi-ai";

export type { ContentBlock, LLMMessage, Usage };

// ── Tools ────────────────────────────────────────────────────────────────────

export interface ToolContext {
  /** Aborted when the run is cancelled or the circuit breaker trips. */
  signal: AbortSignal;
  /** Emit an observability event from inside a tool. */
  emit: (event: AgentEvent) => void;
}

export interface ToolResult {
  /** Text returned to the model as the tool_result. Keep it a DELTA, not the whole page. */
  content: string;
  isError?: boolean;
  /** Optional structured payload for observability/log rendering (e.g. the snapshot shown). */
  observation?: unknown;
}

/**
 * A tool the agent can call. `inputSchema` is JSON Schema. `promptSnippet` is optional
 * extra orientation appended to the system prompt (use sparingly — the point is a small prompt).
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  promptSnippet?: string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ── Store (the browser's "filesystem": durable, host-side, JSON-valued) ───────

export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys, optionally filtered by prefix (e.g. "skills/"). */
  list(prefix?: string): Promise<string[]>;
}

// ── Observability events (every step reconstructable) ─────────────────────────

export type AgentEvent =
  | { type: "agent_start"; system: string; toolNames: string[] }
  | { type: "turn_start"; step: number }
  | { type: "assistant_message"; step: number; content: ContentBlock[]; usage: Usage }
  | { type: "tool_start"; step: number; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; step: number; toolUseId: string; name: string; result: ToolResult; ms: number }
  | { type: "tool_retry"; step: number; name: string; attempt: number; error: string }
  | { type: "guard"; step: number; reason: string; detail: string }
  | { type: "agent_end"; step: number; reason: AgentStopReason; usage: Usage }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

export type AgentStopReason = "done" | "max_steps" | "max_tokens" | "aborted" | "error";

// ── Guards (deterministic reliability, in the harness, not the model) ─────────

export interface GuardConfig {
  /** Max tool-call retries on transient failure (exponential backoff). Default 3. */
  maxRetries?: number;
  /** Base backoff in ms. Default 250. */
  retryBaseMs?: number;
  /** Refuse to re-issue an identical (name,input) that already failed this many times. Default 2. */
  loopThreshold?: number;
}

// ── Agent loop ────────────────────────────────────────────────────────────────

export interface AgentOptions {
  provider: LLMProvider;
  model: string;
  system: string;
  tools: Tool[];
  /** Seed conversation (e.g. the user task). */
  messages: LLMMessage[];
  /** Circuit breaker: max agent steps (a cost fuse, not a model crutch). Default 50. */
  maxSteps?: number;
  /** Circuit breaker: cumulative output-token budget. Optional. */
  maxTokens?: number;
  maxTokensPerCall?: number;
  temperature?: number;
  signal?: AbortSignal;
  guards?: GuardConfig;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
  messages: LLMMessage[];
  stopReason: AgentStopReason;
  steps: number;
  usage: Usage;
  /** Final assistant text (concatenated text blocks of the terminating turn). */
  finalText: string;
}
