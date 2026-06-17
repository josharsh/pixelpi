// @josharsh/pixelpi-cdp — frozen cross-package contract.
// The browser substrate: a thin CDP client, the page snapshot model, the 6 primitives,
// and the self-extension (skill) artifact. Tools implement the @josharsh/pixelpi-core Tool interface.

import type { Store, Tool } from "@josharsh/pixelpi-core";

export type { Store, Tool };

// ── CDP transport ─────────────────────────────────────────────────────────────

/** A single CDP session bound to one target (tab). Thin wrapper over the WebSocket JSON protocol. */
export interface CdpSession {
  /** Send a CDP command and await its result. Throws on protocol error. */
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a CDP event (e.g. "Page.frameNavigated"). Returns an unsubscribe fn. */
  on(event: string, handler: (params: unknown) => void): () => void;
  /** Wait for one occurrence of a CDP event, optionally filtered, with timeout. */
  once<T = unknown>(event: string, opts?: { timeoutMs?: number; filter?: (p: T) => boolean }): Promise<T>;
}

export interface LaunchOptions {
  headless?: boolean;
  /** Persistent profile dir; omit for a fresh disposable profile. */
  userDataDir?: string;
  /** Chrome executable path; auto-detected per platform if omitted. */
  executablePath?: string;
  /** Remote debugging port. Default 0 (auto). */
  port?: number;
  /** Extra Chrome flags. */
  args?: string[];
  startUrl?: string;
}

// ── Page snapshot (the `look` representation — compact, ref-indexed) ──────────

export type LookMode = "a11y" | "dom" | "screenshot";

/** One addressable node. `ref` is a stable per-snapshot integer the model uses in `act`. */
export interface Ref {
  ref: number;
  role: string;
  name: string;
  /** Compact state flags, e.g. "checked", "disabled", "focused", "value=foo". */
  state?: string;
}

export interface Snapshot {
  url: string;
  title: string;
  refs: Ref[];
  /** Present only when mode === "screenshot": base64 PNG (set-of-marks overlay applied). */
  screenshot?: string;
  mode: LookMode;
}

/** Returned by act/fill/nav — only what changed, never the whole page. */
export interface SnapshotDelta {
  url: string;
  title: string;
  /** Human-readable summary of the change + any newly-relevant refs. */
  summary: string;
  refs: Ref[];
}

export type ActOp = "click" | "type" | "select" | "hover" | "press" | "scroll";

// ── Self-extension: a skill is one inspectable artifact stored under "skills/<name>" ──

export interface Skill {
  name: string;
  /** The ONLY field that enters the system prompt. One line. */
  description: string;
  /** URL glob patterns where the skill auto-injects (the @match / PATH analogue). */
  match: string[];
  /** When to inject. */
  runAt?: "documentStart" | "documentIdle";
  /** Function-body source string, run in the page realm. Receives args via the injection channel. */
  fn: string;
  /** Which JS world to inject into. Default "isolated". */
  world?: "main" | "isolated";
}

/** A persisted intent→action resolution (the action cache; replayed with zero LLM tokens). */
export interface CachedAction {
  intent: string;
  urlPattern: string;
  op: ActOp;
  /** How to re-find the target (e.g. "role=button name=Sign in"). */
  refStrategy: string;
  description: string;
}

// ── The 6 primitives, constructed against a live session + durable store ──────

export interface BrowserToolsOptions {
  session: CdpSession;
  store: Store;
  /** Default snapshot mode for `look`. Default "a11y". */
  defaultMode?: LookMode;
}

/**
 * Build the six pixelpi primitives: look, act, fill, nav, eval, store.
 * The single universal escape hatch is `eval`. Everything else is composable from it.
 */
export type CreateBrowserTools = (opts: BrowserToolsOptions) => Tool[];
