import { homedir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Bump when the on-disk shape changes incompatibly. */
export const VERSION = 1;

/** A semantic, ref-free descriptor for one element. ordinal disambiguates same (role,name). */
export interface Target {
  role: string;
  name: string;
  ordinal: number;
}

/** One recorded step. Discriminated on "tool". look is never recorded. */
export type TraceStep =
  | { tool: "nav"; input: { action: string; arg?: string } }
  | { tool: "act"; op: string; value?: string; target: Target; url?: string }
  | { tool: "fill"; fields: { target: Target; value: string }[]; url?: string }
  | { tool: "eval"; input: { fn: string; args?: unknown[]; opts?: Record<string, unknown> } }
  | { tool: "store"; input: { action: "set" | "delete"; key: string; value?: unknown } };

export interface Trace {
  version: number;
  task: string;
  model: string;
  createdAt: string;
  steps: TraceStep[];
  result?: { finalText?: string };
}

const TRACES_DIR = join(homedir(), ".pixelpi", "traces");

/** A bare name has no path separator and does not end in ".json"; anything else is a literal path. */
function isBareName(nameOrPath: string): boolean {
  return !nameOrPath.includes("/") && !nameOrPath.toLowerCase().endsWith(".json");
}

/** lowercase, hyphenate, strip junk, collapse and trim hyphens, cap at ~60 chars. */
export function slugify(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "trace";
}

/**
 * Resolve a name or path to an absolute trace file path.
 * Bare name -> ~/.pixelpi/traces/<name>.trace.json. Path-like -> cwd-relative or absolute as given.
 */
export function resolveTracePath(nameOrPath: string, _opts?: { forWrite?: boolean }): string {
  if (isBareName(nameOrPath)) {
    return join(TRACES_DIR, `${nameOrPath}.trace.json`);
  }
  return isAbsolute(nameOrPath) ? nameOrPath : resolve(process.cwd(), nameOrPath);
}

export function loadTrace(path: string): Trace {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`trace not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid trace (not JSON): ${path}`);
  }
  const trace = parsed as Trace;
  if (!trace || typeof trace !== "object" || !Array.isArray(trace.steps)) {
    throw new Error(`invalid trace (missing steps): ${path}`);
  }
  if (trace.version !== VERSION) {
    throw new Error(`unsupported trace version ${trace.version} (expected ${VERSION}): ${path}`);
  }
  return trace;
}

export function saveTrace(path: string, trace: Trace): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(trace, null, 2) + "\n", "utf8");
}
