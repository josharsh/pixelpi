import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "./client";
import type { CdpSession, LaunchOptions } from "./types";

const DEFAULT_MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
  const executablePath = opts.executablePath ?? process.env.PIXELPI_CHROME ?? DEFAULT_MAC_CHROME;
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

  const proc: ChildProcess = spawn(executablePath, args, { stdio: "ignore" });
  // A missing/un-spawnable Chrome surfaces here (async) — capture it so poll() fails fast & friendly.
  let spawnError: FatalError | undefined;
  proc.once("error", (err) => {
    spawnError = chromeLaunchError(err as NodeJS.ErrnoException, executablePath);
  });
  const guard = () => {
    if (spawnError) throw spawnError;
  };

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
  const target = await poll(() => resolvePageTarget(base, startUrl), 15000);

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.whenReady();

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
