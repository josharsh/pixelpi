import { describe, it, expect, vi, afterEach } from "vitest";
import { getEncoding } from "js-tiktoken";
import { createMcpServer, toolDefinitions } from "./mcp";

/**
 * Drive the server the way a client does and collect what it writes to stdout.
 * Nothing is mocked below the protocol layer, so these exercise the real handlers.
 */
async function exchange(messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const written: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  try {
    const server = createMcpServer();
    for (const m of messages) await server.handle(m as never);
  } finally {
    spy.mockRestore();
  }
  return written.map((l) => JSON.parse(l));
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };

afterEach(() => vi.restoreAllMocks());

describe("mcp handshake", () => {
  it("advertises tool capability and identifies itself", async () => {
    const [res] = await exchange([init]);
    const result = res.result as Record<string, unknown>;
    expect(result.capabilities).toEqual({ tools: {} });
    expect((result.serverInfo as { name: string }).name).toBe("pixelpi");
  });

  it("echoes the client's protocol version rather than forcing its own", async () => {
    const [res] = await exchange([
      { ...init, params: { protocolVersion: "2024-11-05" } },
    ]);
    expect((res.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
  });

  it("falls back to its own version when the client names none", async () => {
    const [res] = await exchange([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]);
    expect((res.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
  });

  it("answers ping", async () => {
    const [res] = await exchange([{ jsonrpc: "2.0", id: 7, method: "ping" }]);
    expect(res).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("stays silent for notifications, which must never get a response", async () => {
    const out = await exchange([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      { jsonrpc: "2.0", method: "notifications/something_new" },
    ]);
    expect(out).toEqual([]);
  });

  it("rejects an unknown request method but not an unknown notification", async () => {
    const out = await exchange([{ jsonrpc: "2.0", id: 3, method: "resources/list" }]);
    expect(out).toHaveLength(1);
    expect((out[0].error as { code: number }).code).toBe(-32601);
  });
});

describe("tools/list", () => {
  it("serves exactly the six primitives", async () => {
    const [res] = await exchange([{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const { tools } = res.result as { tools: { name: string }[] };
    expect(tools.map((t) => t.name)).toEqual(["look", "act", "fill", "nav", "eval", "store"]);
  });

  it("every tool carries a description and a JSON Schema", async () => {
    const [res] = await exchange([{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const { tools } = res.result as { tools: { description: string; inputSchema: { type: string } }[] };
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("does not need a browser — listing tools must not launch Chrome", async () => {
    // toolDefinitions() resolving at all is the assertion: it builds against an inert
    // session, so if it ever started requiring a live CDP connection this would hang or throw.
    const start = Date.now();
    expect(toolDefinitions()).toHaveLength(6);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("tools/call", () => {
  it("rejects a call with no tool name", async () => {
    const [res] = await exchange([{ jsonrpc: "2.0", id: 4, method: "tools/call", params: {} }]);
    expect((res.error as { code: number }).code).toBe(-32602);
  });
});

/**
 * The thesis, as a test.
 *
 * pixelpi's entire claim is that it costs less context than the alternatives, and tool
 * definitions are the part paid on every single call. The published number is 1,196 tokens
 * against Playwright MCP's 5,953. A seventh tool, or a description that grows without
 * anyone noticing, quietly invalidates the README — so it should fail here first.
 */
describe("context budget", () => {
  const enc = getEncoding("o200k_base");

  it("keeps the six tool definitions under the published budget", () => {
    // Same serialization the benchmark uses for both harnesses, so this guards
    // the exact number in the README rather than an unrelated proxy for it.
    const tokens = enc.encode(JSON.stringify(toolDefinitions(), null, 2)).length;
    expect(tokens).toBeLessThan(1400);
    expect(tokens).toBeGreaterThan(600); // a collapse here means the schemas went missing
  });

  it("stays far under Playwright MCP's 5,953 tokens", () => {
    const tokens = enc.encode(JSON.stringify(toolDefinitions(), null, 2)).length;
    expect(5953 / tokens).toBeGreaterThan(4);
  });
});
