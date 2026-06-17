// pixelpi — frozen cross-package contract.

import type { ModelSpec } from "@josharsh/pixelpi-ai";
import type { AgentEvent, AgentResult, Store } from "@josharsh/pixelpi-core";
import type { LaunchOptions } from "@josharsh/pixelpi-cdp";

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
  onEvent?: (event: AgentEvent) => void;
}

export interface PixelpiSession {
  run(): Promise<AgentResult>;
  close(): Promise<void>;
}
