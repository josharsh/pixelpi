import { describe, expect, it } from "vitest";
import { wrapFn } from "./evaltool";

describe("wrapFn", () => {
  it("leaves an arrow expression unchanged", () => {
    const fn = "() => document.title";
    expect(wrapFn(fn)).toBe(fn);
  });

  it("leaves a function expression unchanged", () => {
    const fn = "function(){ return 1; }";
    expect(wrapFn(fn)).toBe(fn);
  });

  it("leaves an async arrow unchanged", () => {
    const fn = "async () => await fetch('/x')";
    expect(wrapFn(fn)).toBe(fn);
  });

  it("leaves an identifier-arrow unchanged", () => {
    const fn = "x => x*2";
    expect(wrapFn(fn)).toBe(fn);
  });

  it("wraps a bare return statement as an async arrow", () => {
    const fn = "return document.title";
    expect(wrapFn(fn)).toBe(`(async (...args) => { ${fn} })`);
  });

  it("wraps a multi-statement body", () => {
    const fn = "const el = document.querySelector('h1'); return el ? el.innerText : null;";
    expect(wrapFn(fn)).toBe(`(async (...args) => { ${fn} })`);
  });
});
