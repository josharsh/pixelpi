import { describe, it, expect } from "vitest";
import { parseArgs, paramCandidates, requiredPlaceholders, renderDescription, errorEvent } from "./cli";
import type { Trace, TraceDescription } from "./trace";

describe("parseArgs", () => {
  it("assembles a plain task from positionals and leaves subcommands unset", () => {
    const f = parseArgs(["go", "to", "example.com"]);
    expect(f.task).toBe("go to example.com");
    expect(f.run).toBeUndefined();
    expect(f.replay).toBeUndefined();
  });

  it("a bare --profile does NOT eat the following task (the historical bug)", () => {
    const f = parseArgs(["--profile", "do a thing"]);
    expect(f.profile).toBe("");
    expect(f.task).toBe("do a thing");
  });

  describe("subcommands consume the next non-flag token as the trace ref", () => {
    it.each(["replay", "run", "vars", "describe"] as const)("%s <name>", (cmd) => {
      const f = parseArgs([cmd, "hn"]);
      expect(f[cmd === "vars" ? "varsCmd" : cmd]).toBe("hn");
      expect(f.task).toBe(""); // a subcommand is present, so no task is assembled
    });

    it("a subcommand with no ref (or a flag next) sets it to empty string", () => {
      expect(parseArgs(["run"]).run).toBe("");
      expect(parseArgs(["run", "--json"]).run).toBe("");
      expect(parseArgs(["run", "--json"]).json).toBe(true);
    });
  });

  describe("--record bare vs value vs =", () => {
    it("bare --record auto-slugs (empty string)", () => {
      expect(parseArgs(["task", "--record"]).record).toBe("");
    });
    it("--record name takes the next token", () => {
      expect(parseArgs(["task", "--record", "hn"]).record).toBe("hn");
    });
    it("--record=name takes the prefix value", () => {
      expect(parseArgs(["task", "--record=hn"]).record).toBe("hn");
    });
    it("--record before a flag does not consume it", () => {
      const f = parseArgs(["task", "--record", "--json"]);
      expect(f.record).toBe("");
      expect(f.json).toBe(true);
    });
  });

  describe("declare (--param/--vars) vs bind (dynamic --<name>)", () => {
    it("--param name=value declares into vars", () => {
      expect(parseArgs(["--param", "q=rust"]).vars).toEqual({ q: "rust" });
    });
    it("--vars name=value is an alias for --param", () => {
      expect(parseArgs(["--vars", "q=rust"]).vars).toEqual({ q: "rust" });
    });
    it("--param=name=value prefix form works", () => {
      expect(parseArgs(["--param=q=rust"]).vars).toEqual({ q: "rust" });
    });
    it("a dynamic --<name> value binds into params, not vars", () => {
      const f = parseArgs(["run", "hn", "--query", "rust"]);
      expect(f.run).toBe("hn");
      expect(f.params).toEqual({ query: "rust" });
      expect(f.vars).toEqual({});
    });
    it("--<name>=value binds too", () => {
      expect(parseArgs(["run", "hn", "--query=rust"]).params).toEqual({ query: "rust" });
    });
  });

  it("parses run flags and numeric values", () => {
    const f = parseArgs(["run", "hn", "--over", "data.csv", "--concurrency", "8", "--timeout", "5000"]);
    expect(f.over).toBe("data.csv");
    expect(f.concurrency).toBe(8);
    expect(f.timeout).toBe(5000);
  });

  it("parses the guardrail flags: --allow-domains, --dry-run, --confirm, --max-tokens", () => {
    const f = parseArgs([
      "do the thing", "--allow-domains", "sessionize.com, github.com", "--dry-run", "--confirm", "--max-tokens", "500000",
    ]);
    expect(f.allowDomains).toEqual(["sessionize.com", "github.com"]);
    expect(f.dryRun).toBe(true);
    expect(f.confirm).toBe(true);
    expect(f.maxTokens).toBe(500000);
    expect(f.task).toBe("do the thing");
  });

  it("--allow-domains=<csv> prefix form works and does not leak into params", () => {
    const f = parseArgs(["--allow-domains=example.com", "read example.com"]);
    expect(f.allowDomains).toEqual(["example.com"]);
    expect(f.params).toEqual({});
    expect(f.task).toBe("read example.com");
  });

  it("--json implies print", () => {
    const f = parseArgs(["task", "--json"]);
    expect(f.json).toBe(true);
    expect(f.print).toBe(true);
  });
});

describe("requiredPlaceholders", () => {
  it("returns distinct {name} placeholders that have no provided value", () => {
    expect(requiredPlaceholders("search HN for {q}...", {})).toEqual(["q"]);
  });
  it("is satisfied once a value is provided", () => {
    expect(requiredPlaceholders("search for {q}", { q: "rust" })).toEqual([]);
  });
  it("dedups repeats and reports several", () => {
    expect(requiredPlaceholders("{a} then {b} then {a}", {})).toEqual(["a", "b"]);
  });
  it("returns nothing when there are no placeholders", () => {
    expect(requiredPlaceholders("search HN for rust", {})).toEqual([]);
  });
});

describe("paramCandidates", () => {
  const base = { version: 1, task: "t", model: "m", createdAt: "now" };

  it("lists entered values (act/fill) before other literals, deduped", () => {
    const trace: Trace = {
      ...base,
      steps: [
        { tool: "nav", input: { action: "goto", arg: "https://site/q=rust" } },
        { tool: "act", op: "type", value: "rust", target: { role: "textbox", name: "Search", ordinal: 0 } },
        { tool: "act", op: "click", target: { role: "button", name: "Go", ordinal: 0 } }, // no value -> not a candidate
        { tool: "eval", input: { fn: "return 1", args: ["rust"] } }, // "rust" dup -> dropped
      ],
    };
    const cands = paramCandidates(trace);
    expect(cands[0]).toMatchObject({ value: "rust" });
    expect(cands[0]!.label).toContain("Search");
    // "rust" appears once (deduped); the nav URL is a separate candidate
    expect(cands.map((c) => c.value)).toEqual(["rust", "https://site/q=rust"]);
  });

  it("skips already-templatized values so re-running vars does not re-offer placeholders", () => {
    const trace: Trace = {
      ...base,
      steps: [{ tool: "act", op: "type", value: "{{q}}", target: { role: "textbox", name: "S", ordinal: 0 } }],
    };
    expect(paramCandidates(trace)).toEqual([]);
  });
});

describe("renderDescription", () => {
  it("renders task, inputs, output, and copy-pasteable usage", () => {
    const d: TraceDescription = {
      name: "hn",
      task: "search for {q}",
      model: "m",
      createdAt: "now",
      version: 1,
      steps: 3,
      params: [{ name: "q", example: "rust", required: true }],
      output: { from: "eval", step: 2 },
    };
    const out = renderDescription(d);
    expect(out).toContain("hn  ·  3 steps");
    expect(out).toContain("search for {q}");
    expect(out).toContain("q   required   example \"rust\"");
    expect(out).toContain("output  eval (step 2)");
    expect(out).toContain("pixelpi run hn --q");
  });

  it("tells you to replay directly when there are no inputs", () => {
    const d: TraceDescription = {
      name: "x",
      task: "t",
      model: "m",
      createdAt: "now",
      version: 1,
      steps: 1,
      params: [],
      output: { from: "none" },
    };
    expect(renderDescription(d)).toContain("replay directly");
  });
});

describe("errorEvent", () => {
  it("is the stable agent-facing error shape", () => {
    expect(errorEvent("no_rows", "empty")).toEqual({ type: "error", code: "no_rows", message: "empty" });
  });
  it("includes detail when provided", () => {
    expect(errorEvent("missing_param", "m", { row: 2 })).toEqual({
      type: "error",
      code: "missing_param",
      message: "m",
      detail: { row: 2 },
    });
  });
});
