import { describe, it, expect } from "vitest";
import { Guard } from "./guard";
import { stableStringify } from "./stableStringify";
import type { Tool, ToolContext } from "./types";

const ctx: ToolContext = { signal: new AbortController().signal, emit: () => {} };

function tool(execute: Tool["execute"]): Tool {
  return { name: "t", description: "t", inputSchema: {}, execute };
}

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: { y: 1, x: 2 } })).toBe(stableStringify({ a: { x: 2, y: 1 } }));
  });
});

describe("Guard", () => {
  it("treats reordered-key inputs as the same signature for loop detection", async () => {
    let runs = 0;
    const g = new Guard({ loopThreshold: 2, maxRetries: 0 });
    const t = tool(async () => {
      runs += 1;
      return { content: "x", isError: true };
    });
    await g.run(1, t, { a: 1, b: 2 }, ctx);
    await g.run(2, t, { b: 2, a: 1 }, ctx);
    const r = await g.run(3, t, { a: 1, b: 2 }, ctx);
    expect(runs).toBe(2);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("different approach");
  });

  it("clears fail count on success so future identical calls are not short-circuited", async () => {
    let runs = 0;
    const g = new Guard({ loopThreshold: 2, maxRetries: 0 });
    // fail, fail (count=2 at the edge but still < threshold each time it ran), then succeed, then run again.
    const outcomes = [true, false, true]; // isError flags for runs 1,2,3
    const t = tool(async () => {
      const isError = outcomes[runs] ?? false;
      runs += 1;
      return isError ? { content: "x", isError: true } : { content: "ok" };
    });
    await g.run(1, t, { a: 1 }, ctx); // priorFails 0 -> run -> fail, count=1
    await g.run(2, t, { a: 1 }, ctx); // priorFails 1 < 2 -> run -> success, count cleared
    await g.run(3, t, { a: 1 }, ctx); // priorFails 0 -> run -> fail, count=1
    expect(runs).toBe(3);
  });
});
