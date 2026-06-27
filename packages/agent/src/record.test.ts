import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@josharsh/pixelpi-core";
import type { Ref, Snapshot, SnapshotDelta } from "@josharsh/pixelpi-cdp";
import { createRecorder } from "./record";

function snap(refs: Ref[]): Snapshot {
  return { url: "https://x", title: "x", refs, mode: "a11y" };
}
function deltaObs(refs: Ref[]): SnapshotDelta {
  return { url: "https://x", title: "x", summary: "ok", refs };
}

function lookStart(id: string): AgentEvent {
  return { type: "tool_start", step: 1, toolUseId: id, name: "look", input: {} };
}
function lookEnd(id: string, refs: Ref[]): AgentEvent {
  return { type: "tool_end", step: 1, toolUseId: id, name: "look", result: { content: "", observation: snap(refs) }, ms: 1 };
}
function start(id: string, name: string, input: Record<string, unknown>): AgentEvent {
  return { type: "tool_start", step: 1, toolUseId: id, name, input };
}
function end(id: string, name: string, content: string, observation: unknown, isError = false): AgentEvent {
  return { type: "tool_end", step: 1, toolUseId: id, name, result: { content, isError, observation }, ms: 1 };
}

describe("createRecorder", () => {
  it("skips look and records act with a resolved descriptor", () => {
    const r = createRecorder();
    const refs = [{ ref: 1, role: "button", name: "Sign in" }];
    r.onEvent(lookStart("l1"));
    r.onEvent(lookEnd("l1", refs));
    r.onEvent(start("a1", "act", { ref: 1, op: "click" }));
    r.onEvent(end("a1", "act", 'click on [1] button "Sign in"', deltaObs([])));
    const t = r.build("task", "m");
    expect(t.steps).toEqual([
      { tool: "act", op: "click", value: undefined, target: { role: "button", name: "Sign in", ordinal: 0 } },
    ]);
  });

  it("computes ordinal among same (role,name)", () => {
    const r = createRecorder();
    const refs = [
      { ref: 1, role: "button", name: "OK" },
      { ref: 2, role: "button", name: "OK" },
      { ref: 3, role: "button", name: "OK" },
    ];
    r.onEvent(lookEnd("l1", refs));
    r.onEvent(start("a1", "act", { ref: 3, op: "click" }));
    r.onEvent(end("a1", "act", "", deltaObs([])));
    const t = r.build("task", "m");
    expect(t.steps[0]).toMatchObject({ target: { role: "button", name: "OK", ordinal: 2 } });
  });

  it("skips a tool_end whose result.isError is true", () => {
    const r = createRecorder();
    const refs = [{ ref: 1, role: "button", name: "Go" }];
    r.onEvent(lookEnd("l1", refs));
    r.onEvent(start("a1", "act", { ref: 1, op: "click" }));
    r.onEvent(end("a1", "act", "loop detected", undefined, true));
    expect(r.build("task", "m").steps).toEqual([]);
  });

  it("records nav and eval verbatim", () => {
    const r = createRecorder();
    r.onEvent(start("n1", "nav", { action: "goto", arg: "https://x" }));
    r.onEvent(end("n1", "nav", "navigated", deltaObs([])));
    r.onEvent(start("e1", "eval", { fn: "return 1", args: [2], opts: { world: "main" } }));
    r.onEvent(end("e1", "eval", "1", { value: 1 }));
    const t = r.build("task", "m");
    expect(t.steps).toEqual([
      { tool: "nav", input: { action: "goto", arg: "https://x" } },
      { tool: "eval", input: { fn: "return 1", args: [2], opts: { world: "main" } } },
    ]);
  });

  it("records store set/delete but skips get/list", () => {
    const r = createRecorder();
    r.onEvent(start("s1", "store", { action: "set", key: "k", value: 1 }));
    r.onEvent(end("s1", "store", "set k", undefined));
    r.onEvent(start("s2", "store", { action: "get", key: "k" }));
    r.onEvent(end("s2", "store", "1", 1));
    r.onEvent(start("s3", "store", { action: "delete", key: "k" }));
    r.onEvent(end("s3", "store", "deleted k", undefined));
    const t = r.build("task", "m");
    expect(t.steps).toEqual([
      { tool: "store", input: { action: "set", key: "k", value: 1 } },
      { tool: "store", input: { action: "delete", key: "k", value: undefined } },
    ]);
  });

  it("records a fill with all fields resolved", () => {
    const r = createRecorder();
    const refs = [
      { ref: 1, role: "textbox", name: "Email" },
      { ref: 2, role: "textbox", name: "Password" },
    ];
    r.onEvent(lookEnd("l1", refs));
    r.onEvent(start("f1", "fill", { fields: [{ ref: 1, value: "a@b.com" }, { ref: 2, value: "pw" }] }));
    r.onEvent(end("f1", "fill", "filled 2", deltaObs([])));
    const t = r.build("task", "m");
    expect(t.steps[0]).toEqual({
      tool: "fill",
      fields: [
        { target: { role: "textbox", name: "Email", ordinal: 0 }, value: "a@b.com" },
        { target: { role: "textbox", name: "Password", ordinal: 0 }, value: "pw" },
      ],
    });
  });

  it("uses the act note fallback when seenRefs cannot resolve the ref", () => {
    const r = createRecorder();
    // no look recorded -> seenRefs empty; resolve via the note
    r.onEvent(start("a1", "act", { ref: 7, op: "click" }));
    r.onEvent(end("a1", "act", 'click on [7] link "Docs"', deltaObs([])));
    const t = r.build("task", "m");
    expect(t.steps[0]).toMatchObject({ target: { role: "link", name: "Docs", ordinal: 0 } });
  });

  it("sets output to the last eval step, or none when there is no eval", () => {
    const r = createRecorder();
    r.onEvent(start("n1", "nav", { action: "goto", arg: "https://x" }));
    r.onEvent(end("n1", "nav", "navigated", deltaObs([])));
    r.onEvent(start("e1", "eval", { fn: "return 1" }));
    r.onEvent(end("e1", "eval", "1", { value: 1 }));
    expect(r.build("task", "m").output).toEqual({ from: "eval", step: 1 });

    const r2 = createRecorder();
    r2.onEvent(start("n1", "nav", { action: "reload" }));
    r2.onEvent(end("n1", "nav", "reloaded", deltaObs([])));
    expect(r2.build("task", "m").output).toEqual({ from: "none" });
  });

  it("captures final assistant text into result.finalText", () => {
    const r = createRecorder();
    r.onEvent({ type: "assistant_message", step: 1, content: [{ type: "text", text: "the answer is 42" }], usage: { inputTokens: 0, outputTokens: 0 } });
    expect(r.build("task", "m").result).toEqual({ finalText: "the answer is 42" });
  });

  it("does not corrupt seenRefs across a skipped error step", () => {
    const r = createRecorder();
    const refs = [{ ref: 1, role: "button", name: "Go" }];
    r.onEvent(lookEnd("l1", refs));
    // failed attempt (isError) then a successful retry both reference ref 1 from the same look
    r.onEvent(start("a1", "act", { ref: 1, op: "click" }));
    r.onEvent(end("a1", "act", "loop", undefined, true));
    r.onEvent(start("a2", "act", { ref: 1, op: "click" }));
    r.onEvent(end("a2", "act", 'click on [1] button "Go"', deltaObs([])));
    const t = r.build("task", "m");
    expect(t.steps).toEqual([
      { tool: "act", op: "click", value: undefined, target: { role: "button", name: "Go", ordinal: 0 } },
    ]);
  });
});
