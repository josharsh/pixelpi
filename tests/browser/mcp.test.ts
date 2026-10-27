import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "MCP emits PNG blocks and interrupts active and queued calls",
  { timeout: 20000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pixelpi-mcp-test-"));
    const child = spawn(
      process.execPath,
      [
        "packages/agent/dist/cli.js",
        "mcp",
        "--headless",
        "--store",
        join(dir, "store.json"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let diagnostics = "";
    child.stderr.on("data", (b) => (diagnostics += b));
    const replies = new Map<number, (v: any) => void>();
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      replies.get(msg.id)?.(msg);
      replies.delete(msg.id);
    });
    const send = (id: number, method: string, params: any = {}) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP request timed out: ${diagnostics}`)),
          8000,
        );
        replies.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    const cancel = (id: number) =>
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id },
        }) + "\n",
      );
    t.after(async () => {
      child.stdin.end();
      await new Promise<void>((r) =>
        child.exitCode !== null ? r() : child.once("exit", () => r()),
      );
      rl.close();
      await rm(dir, { recursive: true, force: true });
    });
    await send(1, "initialize");
    await send(2, "tools/call", {
      name: "nav",
      arguments: { action: "goto", arg: "about:blank" },
    });
    const shot = await send(3, "tools/call", {
      name: "look",
      arguments: { mode: "screenshot" },
    });
    const image = shot.result.content.find((c: any) => c.type === "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(
      Buffer.from(image.data, "base64").subarray(1, 4).toString(),
      "PNG",
    );
    const running = send(4, "tools/call", {
      name: "eval",
      arguments: { fn: "()=>new Promise(()=>{})" },
    });
    const queued = send(5, "tools/call", {
      name: "eval",
      arguments: { fn: '()=>document.title="must not run"' },
    });
    await new Promise((r) => setTimeout(r, 100));
    cancel(5);
    cancel(4);
    assert.equal((await running).result.isError, true);
    assert.equal((await queued).result.isError, true);
    const recovered = await send(6, "tools/call", {
      name: "eval",
      arguments: { fn: "()=>document.title" },
    });
    assert.equal(recovered.result.isError, false);
    assert.equal(recovered.result.content[0].text, '""');
  },
);
