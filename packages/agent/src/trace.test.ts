import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { slugify, resolveTracePath, loadTrace, saveTrace, VERSION, type Trace } from "./trace";

describe("slugify", () => {
  it("lowercases, hyphenates, and strips junk", () => {
    expect(slugify("Go to Hacker News!")).toBe("go-to-hacker-news");
  });

  it("collapses repeated separators and trims edge hyphens", () => {
    expect(slugify("  --Foo   Bar__baz-- ")).toBe("foo-bar-baz");
  });

  it("caps length around 60 chars with no trailing hyphen", () => {
    const s = slugify("a ".repeat(80));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });

  it("falls back to 'trace' for empty input", () => {
    expect(slugify("!!!")).toBe("trace");
  });
});

describe("resolveTracePath name-vs-path rule", () => {
  it("bare name resolves into the home traces library", () => {
    const p = resolveTracePath("login-flow");
    expect(p).toBe(join(homedir(), ".pixelpi", "traces", "login-flow.trace.json"));
  });

  it("a name ending in .json is treated as a literal cwd-relative path", () => {
    const p = resolveTracePath("flows/login.json");
    expect(p).toBe(join(process.cwd(), "flows/login.json"));
  });

  it("a name containing a slash is a literal path even without .json", () => {
    const p = resolveTracePath("./out/x");
    expect(p).toBe(join(process.cwd(), "out/x"));
  });

  it("an absolute path is returned as-is", () => {
    const p = resolveTracePath("/tmp/some.trace.json");
    expect(p).toBe("/tmp/some.trace.json");
  });
});

describe("saveTrace / loadTrace", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pixelpi-trace-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const trace: Trace = {
    version: VERSION,
    task: "do a thing",
    model: "claude-sonnet-4-6",
    createdAt: new Date().toISOString(),
    steps: [{ tool: "nav", input: { action: "goto", arg: "https://example.com" } }],
  };

  it("round-trips through disk, creating nested dirs", () => {
    const path = join(dir, "nested", "deep", "x.trace.json");
    saveTrace(path, trace);
    expect(loadTrace(path)).toEqual(trace);
  });

  it("throws a clear error when the file is missing", () => {
    expect(() => loadTrace(join(dir, "nope.json"))).toThrow(/not found/);
  });

  it("throws on invalid JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json", "utf8");
    expect(() => loadTrace(path)).toThrow(/not JSON/);
  });

  it("throws on a wrong version", () => {
    const path = join(dir, "old.json");
    writeFileSync(path, JSON.stringify({ ...trace, version: 999 }), "utf8");
    expect(() => loadTrace(path)).toThrow(/unsupported trace version/);
  });
});
