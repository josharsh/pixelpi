import { describe, it, expect } from "vitest";
import type { Trace } from "./trace";
import {
  extractLiterals,
  substituteVars,
  templatizeFromExamples,
  validateParams,
} from "./template";

function baseTrace(steps: Trace["steps"]): Trace {
  return { version: 1, task: "t", model: "m", createdAt: "now", steps };
}

describe("substituteVars", () => {
  it("interpolates {{var}} only in templatizable fields and leaves Target/fn untouched", () => {
    const trace = baseTrace([
      { tool: "nav", input: { action: "goto", arg: "https://shop.com/s?q={{query}}" } },
      {
        tool: "act",
        op: "type",
        value: "{{query}}",
        target: { role: "textbox", name: "Search", ordinal: 0 },
      },
      {
        tool: "fill",
        fields: [{ target: { role: "textbox", name: "Email", ordinal: 0 }, value: "{{email}}" }],
      },
      { tool: "eval", input: { fn: "(q) => q + '{{query}}'", args: ["{{query}}", 42] } },
      { tool: "store", input: { action: "set", key: "k-{{query}}", value: "v-{{email}}" } },
    ]);
    const out = substituteVars(trace, { query: "wireless mouse", email: "a@b.com" });

    const nav = out.steps[0] as Extract<Trace["steps"][number], { tool: "nav" }>;
    expect(nav.input.arg).toBe("https://shop.com/s?q=wireless mouse");
    const act = out.steps[1] as Extract<Trace["steps"][number], { tool: "act" }>;
    expect(act.value).toBe("wireless mouse");
    expect(act.target.name).toBe("Search"); // Target never substituted
    const fill = out.steps[2] as Extract<Trace["steps"][number], { tool: "fill" }>;
    expect(fill.fields[0]!.value).toBe("a@b.com");
    const ev = out.steps[3] as Extract<Trace["steps"][number], { tool: "eval" }>;
    expect(ev.input.fn).toBe("(q) => q + '{{query}}'"); // fn NEVER substituted
    expect(ev.input.args).toEqual(["wireless mouse", 42]); // string arg only, number untouched
    const st = out.steps[4] as Extract<Trace["steps"][number], { tool: "store" }>;
    expect(st.input.key).toBe("k-wireless mouse");
    expect(st.input.value).toBe("v-a@b.com");
  });

  it("does not mutate the input trace", () => {
    const trace = baseTrace([
      { tool: "act", op: "type", value: "{{q}}", target: { role: "textbox", name: "S", ordinal: 0 } },
    ]);
    substituteVars(trace, { q: "x" });
    const act = trace.steps[0] as Extract<Trace["steps"][number], { tool: "act" }>;
    expect(act.value).toBe("{{q}}");
  });

  it("leaves unknown {{names}} in place", () => {
    const trace = baseTrace([
      { tool: "act", op: "type", value: "{{a}}-{{b}}", target: { role: "x", name: "y", ordinal: 0 } },
    ]);
    const out = substituteVars(trace, { a: "1" });
    const act = out.steps[0] as Extract<Trace["steps"][number], { tool: "act" }>;
    expect(act.value).toBe("1-{{b}}");
  });
});

describe("templatizeFromExamples", () => {
  it("exact-replaces act/fill/eval-arg/store and substring-replaces nav.arg, then sets params", () => {
    const trace = baseTrace([
      { tool: "nav", input: { action: "goto", arg: "https://shop.com/search?q=wireless mouse&p=1" } },
      {
        tool: "act",
        op: "type",
        value: "wireless mouse",
        target: { role: "textbox", name: "Search", ordinal: 0 },
      },
      { tool: "eval", input: { fn: "(q)=>q", args: ["wireless mouse", "keep"] } },
      { tool: "store", input: { action: "set", key: "wireless mouse", value: "wireless mouse" } },
    ]);
    const out = templatizeFromExamples(trace, { query: "wireless mouse" });

    const nav = out.steps[0] as Extract<Trace["steps"][number], { tool: "nav" }>;
    expect(nav.input.arg).toBe("https://shop.com/search?q={{query}}&p=1"); // substring
    const act = out.steps[1] as Extract<Trace["steps"][number], { tool: "act" }>;
    expect(act.value).toBe("{{query}}"); // exact
    const ev = out.steps[2] as Extract<Trace["steps"][number], { tool: "eval" }>;
    expect(ev.input.args).toEqual(["{{query}}", "keep"]); // only the exact match
    expect(ev.input.fn).toBe("(q)=>q"); // fn untouched
    const st = out.steps[3] as Extract<Trace["steps"][number], { tool: "store" }>;
    expect(st.input.key).toBe("{{query}}");
    expect(st.input.value).toBe("{{query}}");

    expect(out.params).toEqual([{ name: "query", example: "wireless mouse", required: true }]);
  });

  it("does not exact-replace a partial match in act.value", () => {
    const trace = baseTrace([
      {
        tool: "act",
        op: "type",
        value: "wireless mouse pad",
        target: { role: "textbox", name: "S", ordinal: 0 },
      },
    ]);
    const out = templatizeFromExamples(trace, { query: "wireless mouse" });
    const act = out.steps[0] as Extract<Trace["steps"][number], { tool: "act" }>;
    expect(act.value).toBe("wireless mouse pad"); // not exact-equal, so untouched
  });

  it("substring-replaces nav.arg longest-example-first so a longer value wins over its substring", () => {
    // 'mouse' is a substring of 'computer mouse'; processing the longer one first keeps both intact.
    const trace = baseTrace([
      { tool: "nav", input: { action: "goto", arg: "https://shop.com/?cat=computer mouse&q=mouse" } },
    ]);
    const out = templatizeFromExamples(trace, { query: "mouse", category: "computer mouse" });
    const nav = out.steps[0] as Extract<Trace["steps"][number], { tool: "nav" }>;
    expect(nav.input.arg).toBe("https://shop.com/?cat={{category}}&q={{query}}");
  });

  it("ignores empty example values and never touches eval.fn", () => {
    const trace = baseTrace([
      { tool: "eval", input: { fn: "() => location.href", args: [] } },
    ]);
    const out = templatizeFromExamples(trace, { q: "" });
    const ev = out.steps[0] as Extract<Trace["steps"][number], { tool: "eval" }>;
    expect(ev.input.fn).toBe("() => location.href");
    expect(out.params).toEqual([{ name: "q", example: "", required: true }]);
  });
});

describe("extractLiterals", () => {
  it("yields every templatizable literal with its location and skips fn and targets", () => {
    const trace = baseTrace([
      { tool: "nav", input: { action: "goto", arg: "https://x.com" } },
      {
        tool: "act",
        op: "type",
        value: "hello",
        target: { role: "textbox", name: "Q", ordinal: 0 },
      },
      {
        tool: "fill",
        fields: [
          { target: { role: "textbox", name: "Email", ordinal: 0 }, value: "a@b" },
          { target: { role: "textbox", name: "Pass", ordinal: 0 }, value: "pw" },
        ],
      },
      { tool: "eval", input: { fn: "(a)=>a", args: ["strarg", 5] } },
      { tool: "store", input: { action: "set", key: "mykey", value: "myval" } },
    ]);
    const lits = extractLiterals(trace);
    expect(lits).toEqual([
      { stepIndex: 0, tool: "nav", field: "arg", value: "https://x.com" },
      { stepIndex: 1, tool: "act", field: "value", value: "hello" },
      { stepIndex: 2, tool: "fill", field: "fields[0].value", value: "a@b" },
      { stepIndex: 2, tool: "fill", field: "fields[1].value", value: "pw" },
      { stepIndex: 3, tool: "eval", field: "args[0]", value: "strarg" },
      { stepIndex: 4, tool: "store", field: "key", value: "mykey" },
      { stepIndex: 4, tool: "store", field: "value", value: "myval" },
    ]);
    // no literal carries the fn or any target name
    expect(lits.some((l) => l.value.includes("(a)=>a"))).toBe(false);
    expect(lits.some((l) => l.value === "Q" || l.value === "Email")).toBe(false);
  });
});

describe("validateParams", () => {
  const trace = baseTrace([]);
  trace.params = [
    { name: "query", example: "x", required: true },
    { name: "page", example: "1", required: false },
  ];

  it("passes when all required params are present and non-empty", () => {
    expect(validateParams(trace, { query: "shoes" })).toEqual({ ok: true });
  });

  it("fails naming the missing required param", () => {
    expect(validateParams(trace, { page: "2" })).toEqual({ missing: ["query"] });
  });

  it("treats empty string, null, and undefined as missing", () => {
    expect(validateParams(trace, { query: "" })).toEqual({ missing: ["query"] });
    expect(validateParams(trace, { query: null })).toEqual({ missing: ["query"] });
    expect(validateParams(trace, {})).toEqual({ missing: ["query"] });
  });

  it("is ok for a trace with no params", () => {
    expect(validateParams(baseTrace([]), {})).toEqual({ ok: true });
  });
});
