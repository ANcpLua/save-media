import { describe, expect, it, vi } from "vitest";
import { rehydrate, routerPersistence } from "../../../../src/background/state/rehydrate";
import { keysOfTabs, readStoredState, stateKeys, type StoredState } from "../../../../src/background/state/records";
import { createSessionStore } from "../../../../src/background/state/session-store";
import { createRouter } from "../../../../src/background/router";
import { createTabMediaStore, type StoredPart } from "../../../../src/background/tab-media";
import { select as selectMain } from "../../../../src/selection/main-video";
import { directDescriptor, drmDescriptor, hlsDescriptor } from "../../popup/helpers/descriptors";
import { engineStub } from "../../helpers/engine";
import { memoryArea } from "../../helpers/session";
import type { StreamId } from "@savemedia/core";

const choice = { outputMode: "Original", filename: "clip.mp4", variantId: null, audioRenditionId: null } as const;

/** A worker's stateful modules over one storage area, as index.ts wires them. */
function worker(area: ReturnType<typeof memoryArea>) {
  const store = createSessionStore(area);
  const router = createRouter({ engine: engineStub().engine, downloads: { download: async () => 1 }, persist: routerPersistence(store),
    reserveSave: async descriptor => ({ receiptKey: `saved:${descriptor.id}`, resumeKey: null, finish: async () => undefined }) });
  const media = createTabMediaStore(Date.now, (tabId: number, part: StoredPart) => {
    const state = media.tab(tabId);
    if (part === "origins") store.put(stateKeys.origins(tabId), state.origins);
    else if (part === "received") store.put(stateKeys.received(tabId), { received: state.received, earlier: state.earlier, localOrigins: state.localOrigins });
    else if (part === "activity") store.put(stateKeys.activity(tabId), state.activity);
    else if (part === "facts") { if (state.facts) store.put(stateKeys.facts(tabId), state.facts); else store.delete(stateKeys.facts(tabId)); }
    else store.put(stateKeys.media(tabId), { topDocument: state.topDocument, loadFailed: state.loadFailed, frames: state.frames, ads: state.ads, assetLists: state.assetLists,
      timelines: state.timelines, elementDrm: state.elementDrm });
  });
  const apply = (state: StoredState): void => {
    router.importState({ tabs: state.tabs, descriptors: state.descriptors, covered: state.covered, jobs: state.jobs });
    for (const tabId of new Set([...state.media.keys(), ...state.origins.keys(), ...state.received.keys(), ...state.activity.keys(), ...state.facts.keys()])) {
      media.importTab(tabId, { media: state.media.get(tabId), origins: state.origins.get(tabId), received: state.received.get(tabId),
        activity: state.activity.get(tabId), facts: state.facts.get(tabId) });
    }
  };
  return { store, router, media, apply };
}

/** Tab 1 with rows, a running save, ad marks and received addresses; tab 2 with one row. */
async function populated(area = memoryArea()) {
  const first = worker(area);
  for (const item of [hlsDescriptor(), directDescriptor(), drmDescriptor("cdm_required")]) first.router.addDescriptor(1, item);
  first.router.addDescriptor(2, directDescriptor({ id: "other" as StreamId, tabId: 2 }));
  await first.router.startDownload(directDescriptor().id, choice);
  first.media.recordOrigin(1, "https://example.com/clip.mp4", { frameId: 3, documentId: "doc-3", generation: 1, via: ["network-media"], scope: null });
  first.media.noteReceived(1, "https://example.com/clip.mp4", "93.184.216.34", 3);
  first.media.noteLocalOrigin(1, "http://192.168.1.10/movie.mp4");
  first.media.markAds(1, ["https://ads.example/creative.mp4"], "vast", 0);
  first.media.tab(1).frames[3] = { documentId: "doc-3", url: "https://embed.example/player", generation: 1, parent: 0 };
  first.media.changed(1, "media");
  // Tab 2's last navigation failed: it shows the browser's error page.
  first.media.tab(2).loadFailed = true;
  first.media.changed(2, "media");
  first.store.put(stateKeys.loaded, [1, 2]);
  first.store.put(stateKeys.toolbar, [1, 2]);
  first.store.put(stateKeys.diagnostics(2), { v: 1, generation: 0, events: [{ at: "t", event: "scan_started" }], droppedEvents: 0 });
  first.store.put(stateKeys.prompts, [{ v: 1, id: "p2", tabId: 2, pageUrl: "https://b.example/", filename: "b.mp4", receiptKey: "saved:b",
    request: { kind: "page", tabId: 2, pageUrl: "https://b.example/" } }]);
  await first.store.durable();
  return { area, first };
}

describe("a worker start", () => {
  it("brings back rows, the running save, where media came from, what the browser received and the ad marks", async () => {
    const { area, first } = await populated();
    const second = worker(area);
    let applied!: StoredState;
    await rehydrate(second.store, { openTabs: async () => new Set([1, 2]), apply: state => { applied = state; second.apply(state); } });
    expect(second.router.snapshot(1).descriptors).toEqual(JSON.parse(JSON.stringify(first.router.snapshot(1).descriptors)));
    expect(second.router.descriptors(1).map(item => item.id)).toEqual(first.router.descriptors(1).map(item => item.id));
    expect(second.router.job(directDescriptor().id)).toMatchObject({ tabId: 1, origin: "popup" });
    expect(second.router.engineJobCount()).toBe(1);
    expect(second.media.originOf(1, ["https://example.com/clip.mp4"])).toEqual({ frameId: 3, documentId: "doc-3", generation: 1, via: ["network-media"], scope: null });
    // The server address, the frame that received it and the frame's parent are back: a private-address check and an ad mark decide as before.
    expect(second.media.received(1, "https://example.com/clip.mp4")).toEqual({ ip: "93.184.216.34", frameId: 3 });
    // So is the local server the browser itself was answered from: a save after the restart may still request it.
    expect(second.media.localOrigins(1)).toEqual(["http://192.168.1.10"]);
    expect(second.media.localOrigins(2)).toEqual([]);
    expect(second.media.tab(1).frames[3]).toEqual({ documentId: "doc-3", url: "https://embed.example/player", generation: 1, parent: 0 });
    expect(second.media.isAd(1, "https://ads.example/creative.mp4")).toBe(true);
    expect([second.media.tab(1).loadFailed, second.media.tab(2).loadFailed]).toEqual([false, true]);
    expect(applied.loaded).toEqual([1, 2]);
    expect(applied.jobs).toHaveLength(1);
  });

  it("drops everything of tabs that are closed, keeps the save of a closed tab, and deletes what is not this version's", async () => {
    const { area } = await populated();
    area.data["sm0:tab:1"] = { old: true };
    area.data["save-diagnostics-v1-4"] = { events: [] };
    area.data["sm1:tab:1x"] = { v: 1 };
    area.data["sm1:jobs:extra"] = "nonsense";
    area.data["unrelated"] = "kept";
    const second = worker(area);
    let applied!: StoredState;
    // Tab 1 was closed while the worker slept.
    await rehydrate(second.store, { openTabs: async () => new Set([2]), apply: state => { applied = state; second.apply(state); } });
    await second.store.durable();
    expect(second.router.descriptors(1)).toEqual([]);
    expect(second.router.descriptors(2)).toHaveLength(1);
    expect(second.router.engineJobCount()).toBe(1);
    expect(applied.loaded).toEqual([2]);
    expect(applied.toolbar).toEqual([2]);
    expect(applied.prompts.map(prompt => prompt.id)).toEqual(["p2"]);
    expect([...applied.diagnostics.keys()]).toEqual([2]);
    const keys = Object.keys(area.data);
    expect(keysOfTabs(keys, new Set([1]))).toEqual([]);
    expect(keys.filter(key => /^sm0:|^save-diagnostics|1x|jobs:extra/.test(key))).toEqual([]);
    expect(area.data["unrelated"]).toBe("kept");
    expect(area.data[stateKeys.jobs]).toHaveLength(1);
  });

  it("gives two fresh workers the same state from the same store", async () => {
    const { area } = await populated();
    const read = async () => {
      const next = worker(memoryArea(JSON.parse(JSON.stringify(area.data)) as Record<string, unknown>));
      await rehydrate(next.store, { openTabs: async () => new Set([1, 2]), apply: next.apply });
      return { one: next.router.snapshot(1), two: next.router.snapshot(2), origins: next.media.tab(1).origins, jobs: next.router.engineJobCount() };
    };
    expect(await read()).toEqual(await read());
  });

  it("hands the state over before anything that waited for it runs", async () => {
    const { area } = await populated();
    const second = worker(area);
    const order: string[] = [];
    const ready = rehydrate(second.store, { openTabs: async () => new Set([1, 2]), apply: state => { order.push("imported"); second.apply(state); } });
    // What a capture, a popup message and an engine message do: wait for ready, then act.
    for (const name of ["capture", "popup", "engine"]) void ready.then(() => order.push(name));
    await ready;
    await Promise.resolve();
    expect(order).toEqual(["imported", "capture", "popup", "engine"]);
    // A capture the page sends again after the restart finds its row and adds nothing.
    expect(second.router.addDescriptor(1, directDescriptor())).toBe(false);
  });

  it("starts empty from a store that cannot be read, from a broken record and from a failing tab query", async () => {
    const broken = memoryArea({ [stateKeys.tab(1)]: { v: 2 }, [stateKeys.jobs]: [{ v: 1 }], [stateKeys.descriptor(1, "x")]: { id: "y" } });
    const next = worker(broken);
    const logger = { debug() {}, info() {}, warn() {}, error: vi.fn() };
    await rehydrate(next.store, { openTabs: async () => { throw new Error("no tabs"); }, apply: next.apply, logger });
    await next.store.durable();
    expect(next.router.descriptors(1)).toEqual([]);
    expect(Object.keys(broken.data)).toEqual([]);
    expect(readStoredState(new Map()).jobs).toEqual([]);
  });

  it("lists after a restart what was listed before it: a stream of an earlier route that the page still plays, and a player's own video", async () => {
    const area = memoryArea();
    const first = worker(area);
    const select = (w: ReturnType<typeof worker>) => selectMain({ descriptors: w.router.descriptors(1), failures: [], media: w.media.tab(1),
      jobs: w.router.activeJobs(1), facts: w.media.tab(1).facts, usePointer: false });
    const playlist = "https://cdn.example/live/media.m3u8";
    const stream = hlsDescriptor({ id: "played" as StreamId, source: { kind: "hls-manifest", manifestUrl: playlist, type: "media" },
      variants: [{ ...hlsDescriptor().variants[0]!, segmentRef: { kind: "hls-segments", playlistUrl: playlist, initSegmentUrl: null,
        segmentUrls: ["https://cdn.example/live/1.ts"], encryption: null } }] });
    const own = directDescriptor({ id: "own" as StreamId, source: { kind: "direct-url", url: "https://cdn.example/own.mp4", headers: {} } });
    for (const row of [stream, own]) first.router.addDescriptor(1, row);
    first.media.indexOwners(1, stream);
    // Both were found on the page's first route.
    first.media.tab(1).frames[0] = { documentId: "doc", url: "https://app.example/watch?v=1", generation: 0, parent: -1 };
    for (const url of [playlist, "https://cdn.example/own.mp4"]) first.media.recordOrigin(1, url, { frameId: 0, documentId: "doc", generation: 0, via: ["network-fetch"], scope: null });
    // The page moves to another route without a new document. The player goes on requesting the stream,
    // and the popup, opened once, saw that the page's video element shows the file.
    first.media.tab(1).frames[0] = { documentId: "doc", url: "https://app.example/watch?v=1&t=9", generation: 1, parent: -1 };
    first.media.changed(1, "media");
    first.media.touch(1, "https://cdn.example/live/1.ts", 0, 1);
    first.media.setFacts(1, { reachable: true, frames: [{ frameId: 0, documentId: "doc", url: "https://app.example/watch?v=1&t=9", top: true, path: [],
      viewport: { width: 800, height: 600 }, childFrames: [], pageGroups: [], pointer: null, elements: [{ key: "v1",
        source: { kind: "url", url: "https://cdn.example/own.mp4" }, groups: [], render: "visible", box: { x: 0, y: 0, width: 640, height: 360 },
        visible: { x: 0, y: 0, width: 640, height: 360 }, canvas: null, playing: false, played: true, audible: false, muted: false, duration: 60,
        live: false, pip: false, fullscreen: false, keyed: null, width: 640, height: 360, poster: null }] }] });
    const before = select(first);
    expect(before.cards.flatMap(card => card.ids).sort()).toEqual(["own", "played"]);
    await first.store.durable();

    const second = worker(area);
    await rehydrate(second.store, { openTabs: async () => new Set([1]), apply: second.apply });
    const after = select(second);
    expect(after.cards).toEqual(before.cards);
    expect(after.main).toBe(before.main);
  });

  it("reads back the notices on tabs' toolbar buttons, and drops the notice of a tab that is closed", async () => {
    const area = memoryArea();
    const first = worker(area);
    first.store.put(stateKeys.notices, [{ tabId: 1, title: "savemedia: Reload this page so savemedia can see it." }, { tabId: 7, title: "gone" }]);
    await first.store.durable();
    const second = worker(area);
    let applied!: StoredState;
    await rehydrate(second.store, { openTabs: async () => new Set([1]), apply: state => { applied = state; } });
    expect(applied.notices).toEqual([{ tabId: 1, title: "savemedia: Reload this page so savemedia can see it." }]);
    await second.store.durable();
    expect(area.data[stateKeys.notices]).toEqual([{ tabId: 1, title: "savemedia: Reload this page so savemedia can see it." }]);
  });
});
