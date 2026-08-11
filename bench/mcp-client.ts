/**
 * Minimal MCP stdio client — just enough to ask another browser MCP server what it
 * would put in a model's context. Used by efficiency.ts to measure the baseline we
 * actually compete with, instead of a raw-DOM strawman.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private stderr = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => (this.stderr += String(d)));
    this.proc.stdout.on("data", (d) => this.onData(String(d)));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id == null) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  private send(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method} timed out\n${this.stderr.slice(-1500)}`));
      }, timeoutMs);
    });
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pixelpi-bench", version: "1.0.0" },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }

  async listTools(): Promise<McpToolDef[]> {
    const r = (await this.send("tools/list", {})) as { tools?: McpToolDef[] };
    return r.tools ?? [];
  }

  /** Returns the text content a model would receive from this tool call. */
  async callText(name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await this.send("tools/call", { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
    };
    return (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  close(): void {
    this.proc.kill();
  }
}
