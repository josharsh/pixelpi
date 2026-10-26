import { describe, it, expect } from "vitest";
import type { Ref } from "@josharsh/pixelpi-cdp";
import { resolveTarget } from "./match";

function ref(n: number, role: string, name: string): Ref {
  return { ref: n, role, name };
}

describe("resolveTarget", () => {
  it("missing ordinal reports drift even with one remaining match", () => {
    const refs = [ref(1, "button", "Sign in"), ref(2, "link", "Home")];
    expect(
      resolveTarget(refs, { role: "button", name: "Sign in", ordinal: 5 }),
    ).toMatchObject({ drift: true });
  });

  it("multiple matches disambiguate by ordinal", () => {
    const refs = [
      ref(1, "button", "OK"),
      ref(2, "button", "OK"),
      ref(3, "button", "OK"),
    ];
    expect(
      resolveTarget(refs, { role: "button", name: "OK", ordinal: 0 }),
    ).toEqual({ ref: 1 });
    expect(
      resolveTarget(refs, { role: "button", name: "OK", ordinal: 2 }),
    ).toEqual({ ref: 3 });
  });

  it("out-of-range ordinal reports drift", () => {
    const refs = [ref(1, "button", "OK"), ref(2, "button", "OK")];
    expect(
      resolveTarget(refs, { role: "button", name: "OK", ordinal: 9 }),
    ).toMatchObject({ drift: true });
  });

  it("relaxed pass matches case-insensitive + trimmed name", () => {
    const refs = [ref(1, "button", "  Submit ")];
    expect(
      resolveTarget(refs, { role: "button", name: "submit", ordinal: 0 }),
    ).toEqual({ ref: 1 });
  });

  it("relaxed pass respects ordinal across multiple loose matches", () => {
    const refs = [ref(1, "button", "Save"), ref(2, "button", "save ")];
    expect(
      resolveTarget(refs, { role: "button", name: "SAVE", ordinal: 1 }),
    ).toEqual({ ref: 2 });
  });

  it("drift when role exists but no name matches", () => {
    const refs = [ref(1, "button", "Cancel"), ref(2, "button", "Close")];
    const r = resolveTarget(refs, { role: "button", name: "Save", ordinal: 0 });
    expect(r).toMatchObject({ drift: true });
    if ("drift" in r) expect(r.reason).toContain("found 2 button(s)");
  });

  it("drift when the role is absent entirely", () => {
    const refs = [ref(1, "link", "Home")];
    const r = resolveTarget(refs, { role: "button", name: "Save", ordinal: 0 });
    expect(r).toMatchObject({ drift: true });
    if ("drift" in r)
      expect(r.reason).toContain("no button on the current page");
  });

  it("exact match wins over relaxed even when a relaxed candidate exists", () => {
    const refs = [ref(1, "button", "save"), ref(2, "button", "Save")];
    // exact "Save" -> ref 2, not the lowercase one
    expect(
      resolveTarget(refs, { role: "button", name: "Save", ordinal: 0 }),
    ).toEqual({ ref: 2 });
  });
});

it("resolves within the recorded frame only", () => {
  const refs = [
    { ref: 1, role: "button", name: "Save" },
    { ref: 2, role: "button", name: "Save", frame: "0" },
  ];
  expect(
    resolveTarget(refs, {
      role: "button",
      name: "Save",
      ordinal: 0,
      frame: "0",
    }),
  ).toEqual({ ref: 2 });
  expect(
    resolveTarget(refs, {
      role: "button",
      name: "Save",
      ordinal: 0,
      frame: "1",
    }),
  ).toMatchObject({ drift: true });
});
