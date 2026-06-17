import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { MemoryStore, JsonFileStore } from "./store";

describe("MemoryStore", () => {
  it("set/get/delete/list with prefix filtering", async () => {
    const s = new MemoryStore();
    expect(await s.get("missing")).toBeUndefined();
    await s.set("skills/a", { x: 1 });
    await s.set("skills/b", 2);
    await s.set("cache/c", 3);

    expect(await s.get("skills/a")).toEqual({ x: 1 });
    expect(await s.list()).toEqual(["skills/a", "skills/b", "cache/c"]);
    expect((await s.list("skills/")).sort()).toEqual(["skills/a", "skills/b"]);

    await s.delete("skills/a");
    expect(await s.get("skills/a")).toBeUndefined();
    expect(await s.list("skills/")).toEqual(["skills/b"]);
  });
});

describe("JsonFileStore", () => {
  const paths: string[] = [];
  const tmpPath = () => {
    const p = join(tmpdir(), `pixelpi-store-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    paths.push(p);
    return p;
  };

  afterEach(async () => {
    for (const p of paths.splice(0)) await rm(p, { force: true });
  });

  it("set/get/delete/list with prefix filtering", async () => {
    const s = new JsonFileStore(tmpPath());
    expect(await s.get("nope")).toBeUndefined();
    await s.set("skills/one", { ok: true });
    await s.set("notes/two", "hi");

    expect(await s.get("skills/one")).toEqual({ ok: true });
    expect((await s.list()).sort()).toEqual(["notes/two", "skills/one"]);
    expect(await s.list("skills/")).toEqual(["skills/one"]);

    await s.delete("skills/one");
    expect(await s.get("skills/one")).toBeUndefined();
    expect(await s.list("skills/")).toEqual([]);
  });

  it("persists across instances (round-trip via file)", async () => {
    const path = tmpPath();
    const a = new JsonFileStore(path);
    await a.set("skills/persist", { value: 99 });
    await a.set("plain", "text");

    const b = new JsonFileStore(path);
    expect(await b.get("skills/persist")).toEqual({ value: 99 });
    expect(await b.get("plain")).toBe("text");
    expect((await b.list()).sort()).toEqual(["plain", "skills/persist"]);
  });
});
