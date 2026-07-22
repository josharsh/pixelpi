import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "./client";
import type { CdpSession, LaunchOptions } from "./types";

interface VersionInfo {
  webSocketDebuggerUrl?: string;
}

interface TargetInfo {
  type: string;
  webSocketDebuggerUrl: string;
  url: string;
}

/** A launch failure we should surface immediately rather than retry for 15s. */
interface FatalError extends Error {
  fatal?: boolean;
}

async function poll<T>(fn: () => Promise<T>, timeoutMs: number, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      if ((err as FatalError)?.fatal) throw err; // don't retry — Chrome isn't coming
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Turn a raw spawn error into an actionable message about Chrome. */
function chromeLaunchError(err: NodeJS.ErrnoException, execPath: string): FatalError {
  const e: FatalError =
    err.code === "ENOENT"
      ? new Error(
          `Couldn't start Chrome — not found at ${execPath}. ` +
            `Install Google Chrome (https://www.google.com/chrome/) or set PIXELPI_CHROME=/path/to/chrome.`,
        )
      : new Error(
          `Couldn't start Chrome (${err.message}). ` +
            `Set PIXELPI_CHROME=/path/to/chrome if it's installed somewhere unusual.`,
        );
  e.fatal = true;
  return e;
}

/** Find a usable Chrome/Chromium executable, or fail fast with an actionable error. */
export function resolveChromePath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.PIXELPI_CHROME) return process.env.PIXELPI_CHROME;

  let candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  } else if (process.platform === "linux") {
    candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];
  } else if (process.platform === "win32") {
    const bases = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean) as string[];
    for (const b of bases) {
      candidates.push(join(b, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(join(b, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // On linux, fall back to anything on PATH.
  if (process.platform === "linux") {
    for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
      try {
        const found = execSync(`which ${name}`, { stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim();
        if (found) return found;
      } catch {
        /* not on PATH — try next */
      }
    }
  }

  const e: FatalError = new Error(
    "Couldn't find Chrome on this system. " +
      "Install Google Chrome (https://www.google.com/chrome/) or set PIXELPI_CHROME=/path/to/chrome.",
  );
  e.fatal = true;
  throw e;
}

/**
 * When a launch fails because the profile is already in use, tell the user exactly how to free it.
 * Chrome's `SingletonLock` is a symlink whose target is `<hostname>-<pid>` (the pid is the last
 * `-`-delimited token — hostnames may contain dashes). We resolve that pid and, crucially, check
 * whether it's still alive: a live owner needs a `kill`, a dead one is a stale lock to `rm`. Falls
 * back to generic guidance when there's no symlink (Windows, or it was already cleaned up).
 */
export function profileHolderClause(userDataDir: string): string {
  const freshProfile =
    "or use a fresh profile (omit --profile, or pass --profile=<a different dir>).";
  let pid: number;
  try {
    const target = readlinkSync(join(userDataDir, "SingletonLock"));
    pid = parseInt(target.slice(target.lastIndexOf("-") + 1), 10);
  } catch {
    pid = NaN;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    return `Another Chrome is already open with this profile — quit it and retry, ${freshProfile}`;
  }
  let alive = false;
  try {
    process.kill(pid, 0); // signal 0 tests existence without touching the process
    alive = true;
  } catch (e) {
    alive = (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
  if (alive) {
    return (
      `Chrome (pid ${pid}) is already using this profile — it's likely a headless instance with ` +
      `no window to close. Free the profile and retry:\n    kill ${pid}\n${freshProfile}`
    );
  }
  return (
    `a stale lock points at pid ${pid}, which is no longer running. Clear it and retry:\n` +
    `    rm -f ${join(userDataDir, "Singleton*")}\n${freshProfile}`
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Read the actual port Chrome bound to (when launched with port 0). */
function readActivePort(userDataDir: string): number {
  const file = join(userDataDir, "DevToolsActivePort");
  const contents = readFileSync(file, "utf8");
  const port = parseInt(contents.split("\n")[0]!.trim(), 10);
  if (!Number.isFinite(port)) throw new Error("DevToolsActivePort not yet written");
  return port;
}

/** Find an existing page target, or create one at startUrl. */
async function resolvePageTarget(base: string, startUrl: string): Promise<TargetInfo> {
  const list = await fetchJson<TargetInfo[]>(`${base}/json/list`);
  const page = list.find((t) => t.type === "page");
  if (page && page.webSocketDebuggerUrl) {
    return page;
  }
  // /json/new is a PUT in newer Chrome; encode the start url as the path query.
  const res = await fetch(`${base}/json/new?${encodeURIComponent(startUrl)}`, { method: "PUT" });
  if (!res.ok) throw new Error(`/json/new -> ${res.status}`);
  return (await res.json()) as TargetInfo;
}

export async function launchChrome(
  opts: LaunchOptions = {},
): Promise<{ client: CdpClient; session: CdpSession; close: () => Promise<void> }> {
  const executablePath = resolveChromePath(opts.executablePath);
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), "pixelpi-chrome-"));
  const port = opts.port ?? 0;
  const startUrl = opts.startUrl ?? "about:blank";

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
  ];
  if (opts.headless !== false) args.push("--headless=new");
  if (opts.args) args.push(...opts.args);
  args.push(startUrl);

  // A previous run on this profile can leave a stale DevToolsActivePort behind (Chrome
  // killed via SIGTERM doesn't always clean it up). Reading it would point us at a dead
  // port before the new Chrome overwrites the file — remove it so we only see the fresh one.
  try {
    unlinkSync(join(userDataDir, "DevToolsActivePort"));
  } catch {
    /* absent — the common case */
  }

  const proc: ChildProcess = spawn(executablePath, args, { stdio: "ignore" });
  // A missing/un-spawnable Chrome surfaces here (async) — capture it so poll() fails fast & friendly.
  let spawnError: FatalError | undefined;
  proc.once("error", (err) => {
    spawnError = chromeLaunchError(err as NodeJS.ErrnoException, executablePath);
  });
  // If Chrome exits before we've connected, another instance already owns this profile: Chrome's
  // singleton handed our command line to it and this process exits (code 21) without ever writing
  // a debug port. `settled` makes this inert once launch succeeds, so the close()-time kill and any
  // later crash aren't misread as a launch failure. Detecting it here turns a 15s poll timeout into
  // an instant, accurate error — and covers the explicit-port path too, which never reads the port file.
  let settled = false;
  let exitError: FatalError | undefined;
  proc.once("exit", (code) => {
    if (settled) return;
    const e: FatalError = new Error(
      `The Chrome we launched for profile ${userDataDir} exited immediately (code ${code}) — ` +
        profileHolderClause(userDataDir),
    );
    e.fatal = true;
    exitError = e;
  });
  const guard = () => {
    if (spawnError) throw spawnError;
    if (exitError) throw exitError;
  };

  let client: CdpClient;
  try {
    let resolvedPort = port;
    if (port === 0) {
      resolvedPort = await poll(() => {
        guard();
        return Promise.resolve(readActivePort(userDataDir));
      }, 15000);
    }
    const base = `http://127.0.0.1:${resolvedPort}`;
    // Wait for the HTTP endpoint to be live.
    await poll(() => {
      guard();
      return fetchJson<VersionInfo>(`${base}/json/version`);
    }, 15000);
    const target = await poll(() => {
      guard();
      return resolvePageTarget(base, startUrl);
    }, 15000);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.whenReady();
    // A persistent profile can restore the previous run's page into the tab we attach to,
    // silently handing the agent stale navigation state. Reset to startUrl: cookies and
    // storage (the point of --profile) survive; the leftover page does not.
    if (target.url && target.url !== startUrl) {
      await client.send("Page.navigate", { url: startUrl }).catch(() => undefined);
    }
    settled = true;
  } catch (err) {
    settled = true;
    if (!proc.killed) proc.kill();
    if (spawnError) throw spawnError;
    if (exitError) throw exitError;
    const e: FatalError = new Error(
      `Couldn't reach Chrome's debug port for profile ${userDataDir}. ` +
        `Chrome is probably already open with this profile — quit that window and retry, ` +
        `or use a fresh profile (omit --profile, or pass --profile=<a different dir>).`,
    );
    e.fatal = true;
    throw e;
  }

  const close = async () => {
    client.close();
    if (!proc.killed) proc.kill();
    void userDataDir;
  };

  return { client, session: client, close };
}

export async function connectChrome(
  wsOrHttpUrl: string,
): Promise<{ client: CdpClient; session: CdpSession; close: () => Promise<void> }> {
  let wsUrl = wsOrHttpUrl;
  if (wsOrHttpUrl.startsWith("http")) {
    const base = wsOrHttpUrl.replace(/\/$/, "");
    const list = await fetchJson<TargetInfo[]>(`${base}/json/list`);
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) {
      wsUrl = page.webSocketDebuggerUrl;
    } else {
      const ver = await fetchJson<VersionInfo>(`${base}/json/version`);
      if (!ver.webSocketDebuggerUrl) throw new Error("No debuggable target found");
      wsUrl = ver.webSocketDebuggerUrl;
    }
  }
  const client = new CdpClient(wsUrl);
  await client.whenReady();
  const close = async () => client.close();
  return { client, session: client, close };
}
