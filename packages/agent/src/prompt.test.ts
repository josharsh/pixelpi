import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./prompt";

describe("buildSystemPrompt", () => {
  const SIX_TOOLS = ["look", "act", "fill", "nav", "eval", "store"];

  it("names all six tools", () => {
    const p = buildSystemPrompt({ skillDescriptions: [] });
    for (const tool of SIX_TOOLS) {
      expect(p).toContain(tool);
    }
  });

  it("omits the Available skills section when there are no skills", () => {
    const p = buildSystemPrompt({ skillDescriptions: [] });
    expect(p).not.toContain("Available skills");
  });

  it("lists skill descriptions under an Available skills section when provided", () => {
    const p = buildSystemPrompt({
      skillDescriptions: ["gh-star: star the current GitHub repo", "yt-skip: skip the YouTube ad"],
    });
    expect(p).toContain("Available skills:");
    expect(p).toContain("gh-star: star the current GitHub repo");
    expect(p).toContain("yt-skip: skip the YouTube ad");
  });

  it("ignores blank skill descriptions", () => {
    const p = buildSystemPrompt({ skillDescriptions: ["  ", ""] });
    expect(p).not.toContain("Available skills");
  });

  it("warns against simulating untrusted synthetic events and steers to act", () => {
    const p = buildSystemPrompt({ skillDescriptions: [] });
    expect(p).toContain("synthetic events");
    expect(p).toMatch(/KeyboardEvent/);
    expect(p).toMatch(/untrusted/i);
  });

  it("steers toward following an authoritative external link", () => {
    const p = buildSystemPrompt({ skillDescriptions: [] });
    expect(p).toContain("LinkedIn");
    expect(p).toMatch(/external link/i);
  });

  it("stays well under ~600 words", () => {
    const p = buildSystemPrompt({ skillDescriptions: [] });
    expect(p.split(/\s+/).length).toBeLessThan(600);
  });

  it("always carries the task contract: no goal substitution, no invented data, BLOCKED exit", () => {
    const p = buildSystemPrompt({ skillDescriptions: [] });
    expect(p).toContain("Task contract");
    expect(p).toMatch(/never substitute/i);
    expect(p).toMatch(/never invent data/i);
    expect(p).toContain('"BLOCKED: <reason>"');
  });

  it("names the fence domains only when an allowlist is set", () => {
    const off = buildSystemPrompt({ skillDescriptions: [] });
    expect(off).not.toContain("Navigation fence");
    const on = buildSystemPrompt({ skillDescriptions: [], allowDomains: ["sessionize.com"] });
    expect(on).toContain("Navigation fence");
    expect(on).toContain("sessionize.com");
  });

  it("explains the withheld commit boundary only under dryRun", () => {
    const off = buildSystemPrompt({ skillDescriptions: [] });
    expect(off).not.toContain("DRY RUN");
    const on = buildSystemPrompt({ skillDescriptions: [], dryRun: true });
    expect(on).toContain("DRY RUN");
    expect(on).toMatch(/withheld/i);
  });

  it("keeps skills listed after the conditional sections", () => {
    const p = buildSystemPrompt({
      skillDescriptions: ["gh-star: star the current GitHub repo"],
      allowDomains: ["github.com"],
      dryRun: true,
    });
    expect(p).toContain("Available skills:");
    expect(p.indexOf("Navigation fence")).toBeLessThan(p.indexOf("Available skills:"));
  });
});
