import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Tool } from "@josharsh/pixelpi-core";
import type { Ref } from "@josharsh/pixelpi-cdp";
import type { ResolvedSettings } from "./config";
import type { Trace } from "./trace";

// ── module mocks (no real Chrome, no network) ────────────────────────────────

const closeSpy = vi.fn(async () => {});
let pageRefs: Ref[] = [];
const calls: { name: string; input: Record<string, unknown> }[] = [];

vi.mock("@josharsh/pixelpi-cdp", () => {
  const makeTool = (name: string): Tool => ({
    name,
    description: name,
    inputSchema: {},
    async execute(input) {
      calls.push({ name, input });
      if (name === "look") {
        return { content: "page", observation: { url: "u", title: "t", refs: pageRefs, mode: "a11y" } };
      }
      return { content: `${name} ok`, observation: { url: "u", title: "t", summary: "ok", refs: [] } };
    },
  });
  return {
    launchChrome: vi.fn(async () => ({ session: {}, close: closeSpy })),
    createBrowserTools: vi.fn(() => ["look", "act", "fill", "nav", "eval", "store"].map(makeTool)),
  };
});

const runAgentSpy = vi.fn();
vi.mock("@josharsh/pixelpi-core", async (orig) => {
  const actual = await orig<typeof import("@josharsh/pixelpi-core")>();
  return {
    ...actual,
    runAgent: (...args: unknown[]) => runAgentSpy(...args),
    JsonFileStore: class {
      get = async () => undefined;
      set = async () => {};
      delete = async () => {};
      list = async () => [];
    },
  };
});

vi.mock("@josharsh/pixelpi-ai", async (orig) => {
  const actual = await orig<typeof import("@josharsh/pixelpi-ai")>();
  return { ...actual, createProvider: vi.fn(() => ({})) };
});

import { replayTrace } from "./replay";

const settings: ResolvedSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  headless: true,
  storePath: ".pixelpi-store.json",
  keySource: "config",
  apiKey: "sk-x",
  envVar: "ANTHROPIC_API_KEY",
};

function ref(n: number, role: string, name: string): Ref {
  return { ref: n, role, name };
}

beforeEach(() => {
  calls.length = 0;
  closeSpy.mockClear();
  runAgentSpy.mockReset();
  pageRefs = [];
});

describe("replayTrace strict", () => {
  it("replays nav/act/fill/eval/store with no model in the loop", async () => {
    pageRefs = [ref(1, "button", "Sign in"), ref(2, "textbox", "Email")];
    const trace: Trace = {
      version: 1,
      task: "t",
      model: "m",
      createdAt: "now",
      steps: [
        { tool: "nav", input: { action: "goto", arg: "https://x" } },
        { tool: "act", op: "click", target: { role: "button", name: "Sign in", ordinal: 0 } },
        { tool: "fill", fields: [{ target: { role: "textbox", name: "Email", ordinal: 0 }, value: "a@b" }] },
        { tool: "eval", input: { fn: "return 1" } },
        { tool: "store", input: { action: "set", key: "k", value: 1 } },
      ],
    };
    const r = await replayTrace({ trace, settings, tracePath: "/tmp/x.json", heal: false });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    // act and fill each triggered a look first
    expect(calls.filter((c) => c.name === "look").length).toBe(2);
    expect(calls.some((c) => c.name === "act" && c.input.ref === 1)).toBe(true);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(runAgentSpy).not.toHaveBeenCalled();
  });

  it("stops on drift in strict mode and reports it", async () => {
    pageRefs = []; // the recorded button is gone
    const trace: Trace = {
      version: 1,
      task: "t",
      model: "m",
      createdAt: "now",
      steps: [{ tool: "act", op: "click", target: { role: "button", name: "Gone", ordinal: 0 } }],
    };
    const r = await replayTrace({ trace, settings, tracePath: "/tmp/x.json", heal: false });
    expect(r.ok).toBe(false);
    expect(r.drift).toMatchObject({ step: 0 });
    expect(r.steps[0]!.status).toBe("drift");
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("honors an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const trace: Trace = {
      version: 1,
      task: "t",
      model: "m",
      createdAt: "now",
      steps: [{ tool: "nav", input: { action: "reload" } }],
    };
    await expect(
      replayTrace({ trace, settings, tracePath: "/tmp/x.json", heal: false, signal: ac.signal }),
    ).rejects.toThrow(/aborted/);
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

describe("replayTrace heal", () => {
  it("aborts immediately when a repair makes no progress and reports drift", async () => {
    pageRefs = [];
    // runAgent does nothing -> recorder captures no act/fill -> no progress
    runAgentSpy.mockResolvedValue({ messages: [], stopReason: "done", steps: 0, usage: {}, finalText: "" });
    const trace: Trace = {
      version: 1,
      task: "t",
      model: "m",
      createdAt: "now",
      steps: [
        { tool: "act", op: "click", target: { role: "button", name: "A", ordinal: 0 } },
        { tool: "act", op: "click", target: { role: "button", name: "B", ordinal: 0 } },
      ],
    };
    const r = await replayTrace({ trace, settings, tracePath: "/tmp/x.json", heal: true });
    expect(r.ok).toBe(false);
    expect(r.drift).toMatchObject({ step: 0 });
    expect(r.drift?.reason).toMatch(/repair made no progress/);
    // The very first no-progress repair is a hard stop: the second step is never attempted.
    expect(runAgentSpy).toHaveBeenCalledOnce();
    expect(r.steps.length).toBe(1);
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});
