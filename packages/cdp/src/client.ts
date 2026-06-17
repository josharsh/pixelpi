import WebSocket from "ws";
import type { CdpSession } from "./types";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * A flat CDP session over a single WebSocket connection to one page target.
 * Auto-increments command ids, resolves pending promises by id, and dispatches
 * {method, params} events to subscribed handlers. No sessionId routing — we
 * connect directly to a page target's webSocketDebuggerUrl.
 */
export class CdpClient implements CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: unknown) => void>>();
  private ready: Promise<void>;
  private closed = false;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
    });
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("close", () => {
      this.closed = true;
      const err = new Error("CDP connection closed");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  /** Resolves once the socket is open. Callers may await before sending. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (set) for (const h of set) h(msg.params);
    }
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ready;
    if (this.closed) throw new Error("CDP connection closed");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  on(event: string, handler: (params: unknown) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  once<T = unknown>(event: string, opts?: { timeoutMs?: number; filter?: (p: T) => boolean }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.on(event, (params) => {
        if (opts?.filter && !opts.filter(params as T)) return;
        if (timer) clearTimeout(timer);
        off();
        resolve(params as T);
      });
      if (opts?.timeoutMs) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`Timed out waiting for ${event} after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // socket may already be gone
    }
  }
}
