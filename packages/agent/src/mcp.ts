/**
 * pixelpi as an MCP server over stdio.
 *
 * This is the form factor the context-budget claim is actually about. In a CLI nobody
 * ever sees a tool definition; in MCP they are serialized into the model's prompt on
 * every single call, and six lean ones instead of twenty-four is the whole pitch.
 *
 * Deliberately hand-rolled rather than built on @modelcontextprotocol/sdk: that package
 * pulls express, hono, cors, jose, ajv and zod — two HTTP frameworks — for what is, on
 * stdio, five request types. Shipping that to argue about token efficiency would be a
 * little absurd. The protocol surface below is complete for a tools-only server.
 *
 * The one hard rule in here: stdout belongs to JSON-RPC. Every diagnostic goes to stderr,
 * because a stray character on stdout desynchronizes the framing and the client drops us.
 */
import { createInterface } from "node:readline";
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import type { CdpSession } from "@josharsh/pixelpi-cdp";
import { JsonFileStore, MemoryStore, type Tool, type ToolContext } from "@josharsh/pixelpi-core";

/** Protocol version we speak. We echo the client's instead when it names one. */
const PROTOCOL_VERSION = "2025-06-18";

export interface McpServerOptions {
  headless?: boolean;
  /** Persistent Chrome profile, so `pixelpi login` sessions carry over. */
  profileDir?: string;
  storePath?: string;
  allowDomains?: string[];
  dryRun?: boolean;
  /** Deny consequential actions and explain, since an MCP server has no TTY to ask at. */
  confirm?: boolean;
  /** Reported in serverInfo. The CLI passes the package version. */
  version?: string;
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const log = (msg: string) => process.stderr.write(`[pixelpi mcp] ${msg}\n`);

function write(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: Request["id"], result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id: Request["id"], code: number, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

// ── Tool definitions ────────────────────────────────────────────────────────

/**
 * The six definitions, without a browser behind them.
 *
 * `tools/list` must answer instantly and must not cost a Chrome launch — a client that
 * merely enumerates our tools should not spawn a browser. Definitions are static data
 * that never depend on the session, so we build them against an inert stub and let the
 * real, session-bound tools come into existence on the first actual call.
 */
export function toolDefinitions(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  const inert = { on: () => {}, off: () => {}, send: async () => ({}) } as unknown as CdpSession;
  const tools = createBrowserTools({ session: inert, store: new MemoryStore() });
  return tools.map((t: Tool) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

// ── Server ──────────────────────────────────────────────────────────────────

export function createMcpServer(opts: McpServerOptions = {}) {
  let browser: { tools: Tool[]; close: () => Promise<void> } | undefined;
  let booting: Promise<{ tools: Tool[]; close: () => Promise<void> }> | undefined;
  let closed = false;

  /**
   * Chrome starts on the first tool call, not at startup, so an idle server costs nothing.
   * Concurrent first calls share one launch rather than racing two browsers into the same
   * profile directory — which, with a persistent --profile, would lose the singleton fight.
   */
  async function browserTools(): Promise<Tool[]> {
    if (browser) return browser.tools;
    if (!booting) {
      booting = (async () => {
        log(`launching Chrome (${opts.headless === false ? "headed" : "headless"})…`);
        const { session, close } = await launchChrome({
          headless: opts.headless !== false,
          userDataDir: opts.profileDir,
        });
        const tools = createBrowserTools({
          session,
          store: new JsonFileStore(opts.storePath ?? ".pixelpi-store.json"),
          allowDomains: opts.allowDomains,
          dryRun: opts.dryRun,
          confirmAction: opts.confirm ? async () => false : undefined,
        });
        log("Chrome ready");
        return { tools, close };
      })().catch((e) => {
        booting = undefined; // let a later call retry rather than wedging the server
        throw e;
      });
    }
    browser = await booting;
    return browser.tools;
  }

  async function shutdown(): Promise<void> {
    if (closed) return;
    closed = true;
    if (booting) {
      // Never leave a headless Chrome holding the profile lock — an orphan makes the
      // next run fail with a singleton error that reads like a bug in pixelpi.
      try {
        const b = await booting;
        await b.close();
        log("Chrome closed");
      } catch {
        /* launch already failed; nothing to close */
      }
    }
  }

  async function callTool(id: Request["id"], params: Record<string, unknown> | undefined): Promise<void> {
    const name = typeof params?.name === "string" ? params.name : undefined;
    if (!name) return replyError(id, INVALID_PARAMS, "tools/call requires a string 'name'");

    const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
    let tools: Tool[];
    try {
      tools = await browserTools();
    } catch (e) {
      // A browser that won't start is an environment problem, not a bad request: surface
      // it as a tool error so the calling model can read it and tell the user.
      return reply(id, {
        content: [{ type: "text", text: `Could not start Chrome: ${(e as Error).message}` }],
        isError: true,
      });
    }

    const tool = tools.find((t) => t.name === name);
    if (!tool) return replyError(id, INVALID_PARAMS, `unknown tool: ${name}`);

    const ctx: ToolContext = { signal: new AbortController().signal, emit: () => {} };
    try {
      const result = await tool.execute(args, ctx);
      reply(id, { content: [{ type: "text", text: result.content }], isError: result.isError ?? false });
    } catch (e) {
      reply(id, { content: [{ type: "text", text: `${name} failed: ${(e as Error).message}` }], isError: true });
    }
  }

  async function handle(req: Request): Promise<void> {
    switch (req.method) {
      case "initialize": {
        // Echo the client's version when it names one: we have no version-specific
        // behaviour, so agreeing is strictly better than forcing a renegotiation.
        const asked = req.params?.protocolVersion;
        reply(req.id, {
          protocolVersion: typeof asked === "string" ? asked : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "pixelpi", version: opts.version ?? "0.0.0" },
        });
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return; // notifications carry no id and want no response
      case "ping":
        return reply(req.id, {});
      case "tools/list":
        return reply(req.id, { tools: toolDefinitions() });
      case "tools/call":
        return callTool(req.id, req.params);
      default:
        // Notifications we don't know about must stay silent; requests get an error.
        if (req.id === undefined || req.id === null) return;
        return replyError(req.id, METHOD_NOT_FOUND, `unknown method: ${req.method}`);
    }
  }

  return { handle, shutdown, browserTools };
}

export async function runMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(opts);
  const rl = createInterface({ input: process.stdin });

  const stop = async (why: string) => {
    log(`shutting down (${why})`);
    rl.close();
    await server.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  log(`ready — 6 tools, stdio${opts.allowDomains?.length ? `, fenced to ${opts.allowDomains.join(", ")}` : ""}`);

  // Messages are handled in arrival order: two look() calls racing the same page would
  // interleave CDP traffic and hand the model a snapshot of a page mid-navigation.
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let req: Request;
    try {
      req = JSON.parse(text);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "invalid JSON" } });
      return;
    }
    chain = chain.then(() =>
      server.handle(req).catch((e) => {
        log(`handler error: ${(e as Error).message}`);
        if (req.id !== undefined && req.id !== null) replyError(req.id, INTERNAL_ERROR, (e as Error).message);
      }),
    );
  });

  // stdin closing is how an MCP client says goodbye.
  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  await server.shutdown();
}
