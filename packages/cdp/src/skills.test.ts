import { describe, it, expect } from "vitest";
import { matchUrl, skillMatches } from "./skills";
import type { Skill } from "./types";

describe("matchUrl", () => {
  it("matches everything with *", () => {
    expect(matchUrl("*", "https://example.com/anything")).toBe(true);
    expect(matchUrl("*", "")).toBe(true);
  });

  it("matches a prefix glob", () => {
    expect(matchUrl("https://example.co/careers*", "https://example.co/careers")).toBe(true);
    expect(matchUrl("https://example.co/careers*", "https://example.co/careers/123")).toBe(true);
    expect(matchUrl("https://example.co/careers*", "https://example.co/jobs")).toBe(false);
  });

  it("matches exactly when no wildcard", () => {
    expect(matchUrl("https://a.com/x", "https://a.com/x")).toBe(true);
    expect(matchUrl("https://a.com/x", "https://a.com/x/y")).toBe(false);
    expect(matchUrl("https://a.com/x", "https://a.com")).toBe(false);
  });

  it("treats regex special chars as literals", () => {
    expect(matchUrl("https://a.com/x?id=1", "https://a.com/x?id=1")).toBe(true);
    // the dot is literal, so a different char does not match
    expect(matchUrl("https://a.com/x", "https://aXcom/x")).toBe(false);
  });

  it("supports a wildcard in the middle", () => {
    expect(matchUrl("https://*.example.com/*", "https://app.example.com/dash")).toBe(true);
    expect(matchUrl("https://*.example.com/*", "https://other.org/dash")).toBe(false);
  });
});

describe("skillMatches", () => {
  const skill: Skill = {
    name: "careers",
    description: "extract jobs",
    match: ["https://example.co/careers*", "https://jobs.example.co/*"],
    fn: "return 1;",
  };

  it("matches if any pattern matches", () => {
    expect(skillMatches(skill, "https://example.co/careers/eng")).toBe(true);
    expect(skillMatches(skill, "https://jobs.example.co/list")).toBe(true);
  });

  it("does not match unrelated urls", () => {
    expect(skillMatches(skill, "https://example.co/about")).toBe(false);
  });
});
