// pixelpi — frozen cross-package contract.

import type { ModelSpec } from "@josharsh/pixelpi-ai";
import type { AgentEvent, AgentResult, Store } from "@josharsh/pixelpi-core";
import type { LaunchOptions, PendingAction } from "@josharsh/pixelpi-cdp";

export interface PixelpiSessionOptions {
  /** The task instruction (becomes the seed user message). */
  task: string;
  /** Model selection. Defaults to Anthropic Claude (resolved from env if omitted). */
  model?: ModelSpec;
  launch?: LaunchOptions;
  /** Path for the durable JSON store. Default ".pixelpi-store.json" in cwd. */
  storePath?: string;
  /** Pre-built store (overrides storePath). */
  store?: Store;
  maxSteps?: number;
  /** Circuit breaker: cumulative input+output token budget for the run. */
  maxTotalTokens?: number;
  /** Navigation allowlist enforced at the tool layer (hosts + their subdomains). */
  allowDomains?: string[];
  /** Withhold consequential actions (submit/send/purchase) instead of performing them. */
  dryRun?: boolean;
  /** Ask before each consequential action; resolving false withholds it. */
  confirmAction?: (action: PendingAction) => Promise<boolean>;
  onEvent?: (event: AgentEvent) => void;
}

export interface PixelpiSession {
  run(): Promise<AgentResult>;
  close(): Promise<void>;
}
