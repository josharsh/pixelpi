import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "./types";

export class MemoryStore implements Store {
  private readonly data = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.data.has(key) ? this.data.get(key) : undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.data.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
}

/** A Store backed by a single JSON file. Loads lazily on first op; writes atomically. */
export class JsonFileStore implements Store {
  private readonly filePath: string;
  private data: Record<string, unknown> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async load(): Promise<Record<string, unknown>> {
    if (this.data === null) {
      try {
        const raw = await readFile(this.filePath, "utf8");
        this.data = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") this.data = {};
        else throw err;
      }
    }
    return this.data;
  }

  private async flush(): Promise<void> {
    const tmp = this.filePath + ".tmp-" + process.pid + "-" + Date.now();
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  async get(key: string): Promise<unknown> {
    const data = await this.load();
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    delete data[key];
    await this.flush();
  }

  async list(prefix?: string): Promise<string[]> {
    const data = await this.load();
    const keys = Object.keys(data);
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
}
