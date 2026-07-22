import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { headedBrowserArgs, profileHolderClause, resolveChromePath } from "./launch";

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

describe("headedBrowserArgs", () => {
  it("opens a plain headed Chrome with no automation surface", () => {
    const args = headedBrowserArgs("/home/me/.pixelpi/profile", "https://x.com/i/flow/login");
    expect(args).toContain("--user-data-dir=/home/me/.pixelpi/profile");
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--no-default-browser-check");
    // The start url is the last positional so Chrome opens straight to the login page.
    expect(args[args.length - 1]).toBe("https://x.com/i/flow/login");
    // The whole point of the login path: no debug port and no headless — those are exactly what
    // bot-walls fingerprint. If either reappears, sign-in on X/Google breaks again.
    expect(args.some((a) => a.includes("--remote-debugging-port"))).toBe(false);
    expect(args.some((a) => a.includes("--headless"))).toBe(false);
  });
});

describe("profileHolderClause", () => {
  const withLock = (target: string) => {
    const dir = mkdtempSync(join(tmpdir(), "holder-"));
    symlinkSync(target, join(dir, "SingletonLock"));
    return dir;
  };

  it("tells the user to kill the live pid that owns the profile", () => {
    // process.pid is guaranteed alive — the hostname carries dashes to prove pid parsing survives them.
    const msg = profileHolderClause(withLock(`Some-Host.local-${process.pid}`));
    expect(msg).toContain(`kill ${process.pid}`);
    expect(msg).not.toContain("stale");
  });

  it("tells the user to clear a stale lock when the pid is dead", () => {
    // 2^31-ish pid that cannot be running; process.kill(pid, 0) throws ESRCH -> stale branch.
    const msg = profileHolderClause(withLock("Some-Host.local-2147480000"));
    expect(msg).toContain("stale lock");
    expect(msg).toContain("rm -f");
    expect(msg).not.toContain("kill ");
  });

  it("falls back to generic guidance when there is no lock symlink", () => {
    const msg = profileHolderClause(mkdtempSync(join(tmpdir(), "holder-")));
    expect(msg).toContain("Another Chrome is already open");
    expect(msg).not.toContain("kill ");
    expect(msg).not.toContain("stale");
  });
});
