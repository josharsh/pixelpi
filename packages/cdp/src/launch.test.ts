import { afterEach, describe, expect, it } from "vitest";
import { resolveChromePath } from "./launch";

describe("resolveChromePath", () => {
  const original = process.env.PIXELPI_CHROME;
  afterEach(() => {
    if (original === undefined) delete process.env.PIXELPI_CHROME;
    else process.env.PIXELPI_CHROME = original;
  });

  it("returns an explicit path unchanged", () => {
    expect(resolveChromePath("/custom/chrome")).toBe("/custom/chrome");
  });

  it("honors PIXELPI_CHROME when no explicit path is given", () => {
    process.env.PIXELPI_CHROME = "/env/chrome";
    expect(resolveChromePath()).toBe("/env/chrome");
  });

  it("prefers an explicit path over PIXELPI_CHROME", () => {
    process.env.PIXELPI_CHROME = "/env/chrome";
    expect(resolveChromePath("/custom/chrome")).toBe("/custom/chrome");
  });
});
