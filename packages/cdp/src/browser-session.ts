import { CdpClient, onceEvent } from "./client";
import type { CdpSession } from "./types";

interface Attached {
  session: CdpSession;
  id: string;
  targetId: string;
  parent?: string;
  ready: Promise<void>;
}

/** Stable public session that follows the selected tab and its iframe sessions. */
export class BrowserSession implements CdpSession {
  private active!: Attached;
  private attached = new Map<string, Attached>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private forwarded = new Map<string, () => void>();
  constructor(private client: CdpClient) {}

  private register(id: string, targetId: string, parent?: string): Attached {
    const existing = this.attached.get(id);
    if (existing) return existing;
    const session = this.client.session(id);
    const entry: Attached = {
      session,
      id,
      targetId,
      parent,
      ready: Promise.resolve(),
    };
    this.attached.set(id, entry);
    session.on("Target.attachedToTarget", (data) => {
      const e = data as {
        sessionId: string;
        targetInfo: { targetId: string; type: string };
      };
      if (e.targetInfo.type === "iframe")
        this.register(e.sessionId, e.targetInfo.targetId, id);
    });
    session.on("Target.detachedFromTarget", (data) =>
      this.attached.delete((data as { sessionId: string }).sessionId),
    );
    entry.ready = (async () => {
      for (const domain of ["Page", "DOM", "Runtime", "Accessibility"])
        await session.send(`${domain}.enable`);
      await session.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    })();
    void entry.ready.catch(() => undefined);
    return entry;
  }

  async selectTarget(targetId: string): Promise<void> {
    let target = [...this.attached.values()].find(
      (e) => e.targetId === targetId && !e.parent,
    );
    if (!target) {
      const { sessionId } = await this.client.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      target = this.register(sessionId, targetId);
    }
    await target.ready;
    await this.client.send("Target.activateTarget", { targetId });
    for (const off of this.forwarded.values()) off();
    this.forwarded.clear();
    this.active = target;
    for (const event of this.listeners.keys()) this.forward(event);
    this.emit("Pixelpi.targetChanged", { targetId });
  }

  private emit(event: string, data: unknown): void {
    for (const f of this.listeners.get(event) ?? []) f(data);
  }
  private forward(event: string): void {
    if (this.active && !this.forwarded.has(event))
      this.forwarded.set(
        event,
        this.active.session.on(event, (data) => this.emit(event, data)),
      );
  }
  on(event: string, handler: (params: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(handler);
    this.forward(event);
    return () => {
      set!.delete(handler);
      if (!set!.size) {
        this.listeners.delete(event);
        this.forwarded.get(event)?.();
        this.forwarded.delete(event);
      }
    };
  }
  once<T = unknown>(
    event: string,
    opts?: { timeoutMs?: number; filter?: (p: T) => boolean },
  ): Promise<T> {
    return onceEvent(this, event, opts);
  }
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    if (!this.active) throw new Error("No selected browser tab");
    return this.active.session.send<T>(method, params, options);
  }
  async frameSessions(): Promise<CdpSession[]> {
    const belongs = (e: Attached): boolean =>
      e.id === this.active.id ||
      (!!e.parent &&
        !!this.attached.get(e.parent) &&
        belongs(this.attached.get(e.parent)!));
    const entries = [
      this.active,
      ...[...this.attached.values()].filter(
        (e) => e !== this.active && belongs(e),
      ),
    ];
    await Promise.all(entries.map((e) => e.ready));
    return entries.map((e) => e.session);
  }
}
