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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => (this.stderr += String(d)));
    this.proc.stdout.on("data", (d) => this.onData(String(d)));
    this.proc.on("error", (error) => this.failPending(error));
    this.proc.on("exit", () => this.failPending(new Error(`MCP process exited: ${this.stderr.slice(-1000)}`)));
  }

  private failPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
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
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  private send(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method} timed out\n${this.stderr.slice(-1500)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
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
    const r = await this.call(name, args);
    const text = this.text(r);
    if (r.isError) throw new Error(text);
    return text;
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpResult> {
    return await this.send("tools/call", { name, arguments: args }) as McpResult;
  }

  text(r: McpResult): string {
    return (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  async close(): Promise<void> {
    this.failPending(new Error("MCP client closed"));
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
      this.proc.once("exit", () => { clearTimeout(timer); resolve(); });
      this.proc.kill();
    });
  }
}

export interface McpResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}
