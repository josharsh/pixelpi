import { afterEach, describe, it, expect } from "vitest";
import { WebSocketServer } from "ws";
import { CdpClient } from "./client";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function connection() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  const connected = new Promise<any>((r) => server.once("connection", r));
  const client = new CdpClient(
    `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  await client.whenReady();
  const socket = await connected;
  cleanup.push(async () => {
    client.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  socket.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === "echo")
      socket.send(
        JSON.stringify({
          id: msg.id,
          result: { sessionId: msg.sessionId ?? null },
        }),
      );
  });
  return { client, socket };
}
describe("CDP transport lifecycle", () => {
  it("times out and aborts unanswered commands without wedging later requests", async () => {
    const { client } = await connection();
    await expect(client.send("hang", {}, { timeoutMs: 20 })).rejects.toThrow(
      /timed out/,
    );
    const ac = new AbortController();
    const pending = client.send("hang", {}, { signal: ac.signal });
    const check = expect(pending).rejects.toThrow(/aborted/);
    ac.abort();
    await check;
    expect(await client.send("echo")).toEqual({ sessionId: null });
  });
  it("routes child commands and events by session and rejects pending calls on close", async () => {
    const { client, socket } = await connection();
    const child = client.session("child");
    expect(await child.send("echo")).toEqual({ sessionId: "child" });
    const event = child.once("event", { timeoutMs: 1000 });
    socket.send(
      JSON.stringify({
        sessionId: "other",
        method: "event",
        params: { wrong: true },
      }),
    );
    socket.send(
      JSON.stringify({
        sessionId: "child",
        method: "event",
        params: { right: true },
      }),
    );
    expect(await event).toEqual({ right: true });
    const pending = client.send("hang");
    const check = expect(pending).rejects.toThrow(/closed/);
    await new Promise((r) => setTimeout(r, 10));
    client.close();
    await check;
  });
});
