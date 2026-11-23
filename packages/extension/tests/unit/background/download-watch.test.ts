import type { JobError } from "@savemedia/core";
import { describe, expect, it, vi } from "vitest";
import { createDownloadWatch, DownloadEnded } from "../../../src/background/download-watch";
import { createRecoveries } from "../../../src/background/recoveries";
import { createEventHub, type BackgroundEvent } from "../../../src/background/events";
import { createSessionStore } from "../../../src/background/state/session-store";
import { readStoredState, stateKeys } from "../../../src/background/state/records";
import { memoryArea } from "../helpers/session";

type Delta = { id: number; state?: { current: string }; error?: { current: string } };

function downloads(items: Record<number, { state: string; error?: string; url?: string; id?: number }> = {}) {
  const listeners = new Set<(delta: Delta) => void>();
  const api = {
    onChanged: { addListener: vi.fn((listener: (delta: Delta) => void) => { listeners.add(listener); }),
      removeListener: vi.fn((listener: (delta: Delta) => void) => { listeners.delete(listener); }) },
    search: vi.fn(async (query: { id?: number; url?: string }) => Object.entries(items)
      .filter(([id, item]) => (query.id === undefined || Number(id) === query.id) && (query.url === undefined || item.url?.startsWith(query.url)))
      .map(([id, item]) => ({ id: Number(id), ...item }))),
  };
  return { api: api as never, raw: api, items, fire: (delta: Delta) => { for (const listener of [...listeners]) listener(delta); }, listeners };
}

describe("waiting for the browser's download manager", () => {
  it("listens from the worker's start, so a download that ends while the worker sleeps wakes it", () => {
    const d = downloads();
    createDownloadWatch(d.api, true);
    expect(d.raw.onChanged.addListener).toHaveBeenCalledOnce();
  });

  it("resolves on completion and rejects with Chrome's reason otherwise", async () => {
    const d = downloads({ 1: { state: "in_progress" }, 2: { state: "in_progress" } });
    const watch = createDownloadWatch(d.api, true);
    const done = watch.wait(1);
    const stopped = watch.wait(2).catch(error => error as unknown);
    await Promise.resolve();
    d.fire({ id: 1, state: { current: "complete" } });
    d.fire({ id: 2, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } });
    expect(await done).toBe(1);
    const error = await stopped;
    expect(error).toBeInstanceOf(DownloadEnded);
    expect(error).toMatchObject({ state: "interrupted", reason: "USER_CANCELED", message: "USER_CANCELED" });
  });

  it("sees a download that had already ended when the wait began: after a worker restart, or before the listener was in place", async () => {
    const d = downloads({ 5: { state: "complete" }, 6: { state: "interrupted", error: "FILE_NO_SPACE" } });
    const watch = createDownloadWatch(d.api);
    expect(await watch.wait(5)).toBe(5);
    await expect(watch.wait(6)).rejects.toMatchObject({ reason: "FILE_NO_SPACE" });
    await expect(watch.wait(404)).rejects.toBeInstanceOf(DownloadEnded);
    // A watch made for one wait takes its listener away again.
    expect(d.listeners.size).toBe(0);
  });

  it("finds the download the browser already has for exactly this Blob address", async () => {
    const d = downloads({ 3: { state: "in_progress", url: "blob:chrome-extension://x/1" }, 4: { state: "complete", url: "blob:chrome-extension://x/11" } });
    const watch = createDownloadWatch(d.api);
    expect(await watch.findByUrl("blob:chrome-extension://x/1")).toBe(3);
    expect(await watch.findByUrl("blob:chrome-extension://x/2")).toBeNull();
  });
});

describe("Chrome's own resume of an interrupted download, across a worker restart", () => {
  const PAGE = "https://site.example/file";

  function recoveries(area: ReturnType<typeof memoryArea>, watch: { wait: (id: number) => Promise<number> }, generation = 0,
    settle?: (downloadId: number) => Promise<JobError | null>) {
    const store = createSessionStore(area);
    const emitted: BackgroundEvent[] = [];
    const hub = createEventHub();
    hub.on(event => emitted.push(event));
    const finish = vi.fn(async (_saved: boolean) => undefined);
    const instance = createRecoveries({ store, events: hub, watch, generation: () => generation, permitFrom: data => ({ ...data, finish }),
      ...(settle ? { settle } : {}) });
    return { store, emitted, finish, instance };
  }

  it("reports what Chrome resumes, stores it once Chrome accepted the resume, and ends it", async () => {
    const area = memoryArea();
    const r = recoveries(area, { wait: async id => id });
    const progress = { stage: { kind: "resuming" }, bytesWritten: 10, bytesTotal: 40 } as const;
    r.instance.update(7, PAGE, progress);
    expect(r.emitted).toEqual([{ type: "file-recovery", tabId: 7, generation: 0, pageUrl: PAGE, progress, found: true, error: null }]);
    await r.store.durable();
    expect(area.data[stateKeys.recoveries]).toBeUndefined();
    r.instance.started(7, PAGE, "Clip 31.mov", 91, "saved:abc");
    r.instance.update(7, PAGE, { ...progress, bytesWritten: 20 });
    await r.store.durable();
    expect(area.data[stateKeys.recoveries]).toEqual([{ v: 1, tabId: 7, pageUrl: PAGE, filename: "Clip 31.mov", downloadId: 91, receiptKey: "saved:abc",
      generation: 0, progress: { ...progress, bytesWritten: 20 } }]);
    expect(r.emitted.at(-1)).toMatchObject({ found: false });
    expect(r.instance.current(7, PAGE)).toMatchObject({ bytesWritten: 20 });
    expect(r.instance.current(7, "https://site.example/other")).toBeNull();
    expect(r.instance.receipts()).toEqual(["saved:abc"]);
    r.instance.update(7, PAGE, null);
    await r.store.durable();
    expect(area.data[stateKeys.recoveries]).toEqual([]);
    expect(r.emitted.at(-1)).toMatchObject({ progress: null, error: null });
  });

  async function restarted(wait: (id: number) => Promise<number>, settle?: (downloadId: number) => Promise<JobError | null>) {
    const area = memoryArea();
    const first = recoveries(area, { wait: async id => id });
    first.instance.update(7, PAGE, { stage: { kind: "resuming" }, bytesWritten: 10, bytesTotal: 40 });
    first.instance.started(7, PAGE, "Clip 31.mov", 91, "saved:abc");
    await first.store.durable();
    const second = recoveries(area, { wait }, 0, settle);
    second.instance.import(readStoredState(await second.store.load()).recoveries);
    return { area, second };
  }

  it("a restarted worker waits for the same download, writes the receipt when it completes and shows the default button again", async () => {
    const wait = vi.fn(async (id: number) => id);
    const { area, second } = await restarted(wait);
    expect(second.instance.current(7, PAGE)).toMatchObject({ bytesWritten: 10 });
    await second.instance.resume();
    expect(wait).toHaveBeenCalledExactlyOnceWith(91, expect.any(Function));
    expect(second.finish).toHaveBeenCalledExactlyOnceWith(true);
    expect(second.emitted).toEqual([{ type: "file-recovery", tabId: 7, generation: 0, pageUrl: PAGE, progress: null, found: false, error: null }]);
    await second.store.durable();
    expect(area.data[stateKeys.recoveries]).toEqual([]);
  });

  it("a restarted worker goes on reporting the resume's bytes, until the tab shows another page", async () => {
    let report!: (item: chrome.downloads.DownloadItem) => void;
    let finish!: (id: number) => void;
    const { area, second } = await restarted(((_id: number, onUpdate: typeof report) => {
      report = onUpdate;
      return new Promise<number>(resolve => { finish = resolve; });
    }) as never);
    const resumed = second.instance.resume();
    report({ bytesReceived: 30, totalBytes: 40 } as chrome.downloads.DownloadItem);
    expect(second.emitted).toEqual([{ type: "file-recovery", tabId: 7, generation: 0, pageUrl: PAGE,
      progress: { stage: { kind: "resuming" }, bytesWritten: 30, bytesTotal: 40 }, found: false, error: null }]);
    expect(second.instance.current(7, PAGE)).toMatchObject({ bytesWritten: 30 });
    await second.store.durable();
    expect((area.data[stateKeys.recoveries] as { progress: unknown }[])[0]!.progress).toMatchObject({ bytesWritten: 30 });
    // The tab left the page: the download goes on, its bytes are no longer this tab's to show.
    second.instance.forgetTab(7);
    report({ bytesReceived: 35, totalBytes: 40 } as chrome.downloads.DownloadItem);
    expect(second.emitted).toHaveLength(1);
    finish(91);
    await resumed;
  });

  it("a restarted worker does not count a resume as saved when the server answered it with something that is no video", async () => {
    const refused: JobError = { code: "unexpected_media_response", severity: "terminal", response: "page", host: "cdn.example" };
    const settle = vi.fn(async () => refused);
    const { second } = await restarted(async id => id, settle);
    await second.instance.resume();
    expect(settle).toHaveBeenCalledExactlyOnceWith(91);
    expect(second.finish).toHaveBeenCalledExactlyOnceWith(false);
    expect(second.emitted[0]).toMatchObject({ type: "file-recovery", progress: null, error: refused });
    expect(second.emitted[1]).toMatchObject({ type: "file-save", problem: { filename: "Clip 31.mov", error: refused } });
  });

  it("a resume that Chrome could not finish frees the reservation and says so on the file's row", async () => {
    const { second } = await restarted(async () => { throw new DownloadEnded("interrupted", "NETWORK_FAILED"); });
    await second.instance.resume();
    expect(second.finish).toHaveBeenCalledExactlyOnceWith(false);
    expect(second.emitted.map(event => event.type)).toEqual(["file-recovery", "file-save"]);
    expect(second.emitted[0]).toMatchObject({ progress: null, error: { code: "engine_job_failed", cause: "browser-resume" } });
    expect(second.emitted[1]).toMatchObject({ pageUrl: PAGE, problem: { filename: "Clip 31.mov", stage: "transferring", error: { code: "engine_job_failed", cause: "browser-resume" } } });
    expect(second.instance.current(7, PAGE)).toBeNull();
  });
});
