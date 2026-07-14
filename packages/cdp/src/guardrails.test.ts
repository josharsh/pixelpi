import { describe, it, expect } from "vitest";
import { hostAllowed, isConsequentialClick } from "./guardrails";

describe("hostAllowed", () => {
  it("allows everything when the allowlist is empty", () => {
    expect(hostAllowed("https://anywhere.com/x", [])).toBe(true);
  });

  it("allows the exact host and its subdomains", () => {
    expect(hostAllowed("https://sessionize.com/devsum-2026", ["sessionize.com"])).toBe(true);
    expect(hostAllowed("https://www.sessionize.com/", ["sessionize.com"])).toBe(true);
    expect(hostAllowed("https://api.eu.sessionize.com/v2", ["sessionize.com"])).toBe(true);
  });

  it("refuses other hosts, including suffix look-alikes", () => {
    expect(hostAllowed("https://google.com/search?q=cfp", ["sessionize.com"])).toBe(false);
    expect(hostAllowed("https://notsessionize.com/", ["sessionize.com"])).toBe(false);
    expect(hostAllowed("https://sessionize.com.evil.io/", ["sessionize.com"])).toBe(false);
  });

  it("checks every entry in the list and ignores case", () => {
    expect(hostAllowed("https://B.com/x", ["a.com", "b.com"])).toBe(true);
    expect(hostAllowed("https://c.com/x", ["a.com", "b.com"])).toBe(false);
  });

  it("tolerates a *. prefix on entries", () => {
    expect(hostAllowed("https://app.example.com/", ["*.example.com"])).toBe(true);
    expect(hostAllowed("https://example.com/", ["*.example.com"])).toBe(true);
  });

  it("always allows blank and browser-internal pages", () => {
    expect(hostAllowed("about:blank", ["example.com"])).toBe(true);
    expect(hostAllowed("chrome://new-tab-page/", ["example.com"])).toBe(true);
  });

  it("fails closed on an unparseable URL", () => {
    expect(hostAllowed("not a url at all", ["example.com"])).toBe(false);
  });
});

describe("isConsequentialClick", () => {
  it("flags submit/send/purchase-shaped button clicks", () => {
    expect(isConsequentialClick("click", "button", "Submit session to event")).toBe(true);
    expect(isConsequentialClick("click", "button", "Send message")).toBe(true);
    expect(isConsequentialClick("click", "button", "Place order")).toBe(true);
    expect(isConsequentialClick("click", "button", "Sign up")).toBe(true);
    expect(isConsequentialClick("click", "link", "Publish")).toBe(true);
  });

  it("ignores navigation and reading clicks", () => {
    expect(isConsequentialClick("click", "button", "Next")).toBe(false);
    expect(isConsequentialClick("click", "link", "Speakers")).toBe(false);
    expect(isConsequentialClick("click", "button", "Show more")).toBe(false);
  });

  it("only applies to clicks on interactive roles", () => {
    expect(isConsequentialClick("type", "textbox", "Submit")).toBe(false);
    expect(isConsequentialClick("click", "heading", "Submit your talk today!")).toBe(false);
  });
});
