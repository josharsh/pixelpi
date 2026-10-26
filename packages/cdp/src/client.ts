import WebSocket from "ws";
import type { CdpSession } from "./types";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** CDP transport, including flattened child sessions and bounded commands. */
export class CdpClient implements CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: unknown) => void>>();
  private ready: Promise<void>;
  private closed = false;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl, {
      maxPayload: 256 * 1024 * 1024,
      handshakeTimeout: 15000,
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("close", () => this.fail(new Error("CDP connection closed")));
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    this.pending.clear();
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      sessionId?: string;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      p.cleanup();
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const h of this.handlers.get(
        `${msg.sessionId ?? ""}:${msg.method}`,
      ) ?? [])
        h(msg.params);
    }
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    return this.command<T>(undefined, method, params, options);
  }

  private async command<T>(
    sessionId: string | undefined,
    method: string,
    params?: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    options.signal?.throwIfAborted();
    await this.ready;
    options.signal?.throwIfAborted();
    if (this.closed) throw new Error("CDP connection closed");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const stop = (error: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.cleanup();
        reject(error);
      };
      const abort = () => stop(new Error("CDP command aborted"));
      const timer = setTimeout(
        () => stop(new Error(`CDP command timed out: ${method}`)),
        options.timeoutMs ?? 30000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        cleanup,
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      this.ws.send(
        JSON.stringify({ id, method, params: params ?? {}, sessionId }),
        (error) => {
          if (error) stop(error);
        },
      );
    });
  }

  private subscribe(
    sessionId: string | undefined,
    event: string,
    handler: (params: unknown) => void,
  ): () => void {
    const key = `${sessionId ?? ""}:${event}`;
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (!set!.size) this.handlers.delete(key);
    };
  }

  on(event: string, handler: (params: unknown) => void): () => void {
    return this.subscribe(undefined, event, handler);
  }
  once<T = unknown>(
    event: string,
    opts?: { timeoutMs?: number; filter?: (p: T) => boolean },
  ): Promise<T> {
    return onceEvent<T>(this, event, opts);
  }

  session(sessionId: string): CdpSession {
    const view: CdpSession = {
      send: (method, params, options) =>
        this.command(sessionId, method, params, options),
      on: (event, handler) => this.subscribe(sessionId, event, handler),
      once: (event, opts) => onceEvent(view, event, opts),
    };
    return view;
  }

  close(): void {
    this.fail(new Error("CDP connection closed"));
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export function onceEvent<T>(
  session: CdpSession,
  event: string,
  opts: { timeoutMs?: number; filter?: (p: T) => boolean } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for ${event}`));
    }, opts.timeoutMs ?? 30000);
    const off = session.on(event, (params) => {
      if (opts.filter && !opts.filter(params as T)) return;
      clearTimeout(timer);
      off();
      resolve(params as T);
    });
  });
}
