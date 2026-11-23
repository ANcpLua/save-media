import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionStore } from "../../../../src/background/state/session-store";
import { memoryArea } from "../../helpers/session";

// Fake timers that are never advanced: a store that paced its writes with a timer would write nothing here.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("session store", () => {
  it("writes the changes of one task as one write", async () => {
    const area = memoryArea();
    const store = createSessionStore(area);
    for (let n = 0; n < 100; n++) store.put(`key-${n % 10}`, n);
    expect(area.set).not.toHaveBeenCalled();
    await store.durable();
    expect(area.set).toHaveBeenCalledOnce();
    expect(area.data).toEqual(Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`key-${n}`, 90 + n])));
  });

  it("turns changes made during a write into exactly one more write, with the latest values", async () => {
    const area = memoryArea();
    let release!: () => void;
    area.set.mockImplementationOnce(async items => {
      await new Promise<void>(resolve => { release = resolve; });
      Object.assign(area.data, items);
    });
    const store = createSessionStore(area);
    store.put("a", 1);
    await Promise.resolve();
    expect(area.set).toHaveBeenCalledOnce();
    for (let n = 2; n <= 50; n++) store.put("a", n);
    store.put("b", "x");
    const durable = store.durable();
    let settled = false;
    void durable.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    // The covering write has not happened yet.
    expect(settled).toBe(false);
    expect(area.set).toHaveBeenCalledOnce();
    release();
    await durable;
    expect(area.set).toHaveBeenCalledTimes(2);
    expect(area.data).toEqual({ a: 50, b: "x" });
  });

  it("keeps the order of a put and a delete of the same key", async () => {
    const area = memoryArea({ gone: 1 });
    const store = createSessionStore(area);
    store.put("kept", 1);
    store.delete("kept");
    store.put("kept", 2);
    store.put("gone", 2);
    store.delete("gone");
    await store.durable();
    expect(area.data).toEqual({ kept: 2 });
  });

  it("stores bytes as text and reads everything once", async () => {
    const area = memoryArea();
    const store = createSessionStore(area);
    store.put("key", { iv: new Uint8Array([0, 255, 16]), list: [new Uint8Array([1])], skip: undefined });
    await store.durable();
    expect(area.data).toEqual({ key: { iv: { $bytes: "00ff10" }, list: [{ $bytes: "01" }] } });
    expect([...(await store.load())]).toEqual([["key", { iv: { $bytes: "00ff10" }, list: [{ $bytes: "01" }] }]]);
  });

  /** An area that refuses a write when what it holds would pass `quota` characters of JSON. */
  function quotaArea(quota: number, initial: Record<string, unknown> = {}) {
    const area = memoryArea(initial);
    const size = (items: Record<string, unknown>): number => Object.values(items).reduce<number>((sum, value) => sum + JSON.stringify(value).length, 0);
    const plain = area.set.getMockImplementation()!;
    area.set.mockImplementation(async items => {
      const kept = Object.fromEntries(Object.entries(area.data).filter(([key]) => !(key in items)));
      if (size(kept) + size(items) > quota) throw new Error("refused");
      await plain(items);
    });
    return Object.assign(area, { getBytesInUse: vi.fn(async (keys: string[]) => size(Object.fromEntries(keys.flatMap(key => key in area.data ? [[key, area.data[key]]] : [])))) });
  }

  it("makes room when the browser refuses a write: the group that takes the most room goes, the others stay", async () => {
    const area = quotaArea(100, { "tab-1": "x".repeat(60), "tab-2": "y".repeat(10), "diag": "d".repeat(5) });
    const store = createSessionStore(area, { expendable: () => [["diag"], ["tab-2"], ["tab-1"]] });
    store.put("job", { phase: "starting" });
    await store.durable();
    expect(area.remove).toHaveBeenCalledExactlyOnceWith(["tab-1"]);
    expect(area.data).toEqual({ "tab-2": "y".repeat(10), diag: "ddddd", job: { phase: "starting" } });
  });

  it("drops the tab that is filling the store, with what it was about to write, and keeps the job written with it", async () => {
    const area = quotaArea(100, { "other:tab": "o".repeat(40) });
    const store = createSessionStore(area, { expendable: () => [["other:tab"], ["big:row", "big:tab"]] });
    store.put("big:row", "r".repeat(500));
    store.put("big:tab", { rows: 1 });
    store.put("jobs", [{ id: "a" }]);
    await store.durable();
    expect(area.data).toEqual({ "other:tab": "o".repeat(40), jobs: [{ id: "a" }] });
  });

  it("writes the values one by one when nothing expendable is left, so one that does not fit fails alone", async () => {
    const area = quotaArea(100);
    const warn = vi.fn();
    const store = createSessionStore(area, { logger: { debug() {}, info() {}, warn, error() {} } });
    store.put("huge", "h".repeat(500));
    store.put("jobs", [{ id: "a" }]);
    store.put("prompts", []);
    await store.durable();
    expect(area.data).toEqual({ jobs: [{ id: "a" }], prompts: [] });
    expect(warn).toHaveBeenCalledExactlyOnceWith("persistence_degraded");
  });

  it("logs once and goes on when the browser keeps refusing: memory stays the truth", async () => {
    const area = memoryArea();
    area.set.mockRejectedValue(new Error("quota"));
    const warn = vi.fn();
    const store = createSessionStore(area, { logger: { debug() {}, info() {}, warn, error() {} } });
    store.put("a", 1);
    await store.durable();
    store.put("b", 2);
    await store.durable();
    expect(warn).toHaveBeenCalledExactlyOnceWith("persistence_degraded");
    expect(area.data).toEqual({});
  });

  it("without a storage area is a store that is always durable and always empty", async () => {
    const store = createSessionStore(undefined);
    store.put("a", 1);
    await store.durable();
    expect((await store.load()).size).toBe(0);
  });

  it("reads a store that cannot be read as empty", async () => {
    const area = memoryArea({ a: 1 });
    area.get.mockRejectedValueOnce(new Error("unavailable"));
    expect((await createSessionStore(area).load()).size).toBe(0);
  });
});
