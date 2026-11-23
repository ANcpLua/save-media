import { describe, expect, it, vi } from "vitest";
import { createFactsCollector, createRouteFollower, factsOfCurrentRoutes } from "../../../src/background/page-facts";
import type { CollectedFrame, TabFacts } from "../../../src/types/page-facts";

const reply = (top: boolean) => ({ url: top ? "https://site.test/" : "https://player.test/", top, path: top ? [] : [0],
  viewport: { width: 800, height: 600 }, childFrames: [], elements: [], pageGroups: [], pointer: null, ...(top ? { page: { title: "T" } } : {}) });

describe("facts collector", () => {
  it("asks every frame at once, addresses each by its document, and drops answers that are not facts", async () => {
    const send = vi.fn(async (_tabId: number, target: { frameId: number }) => target.frameId === 0 ? reply(true)
      : target.frameId === 4 ? reply(false) : target.frameId === 5 ? { url: 3 } : null);
    const setFacts = vi.fn();
    const collector = createFactsCollector({ send, store: { setFacts }, frames: { frames: async () => [
      { frameId: 0, parentFrameId: -1, documentId: "A", url: "", generation: 0 }, { frameId: 4, parentFrameId: 0, documentId: "P", url: "", generation: 0 },
      { frameId: 5, parentFrameId: 0, documentId: null, url: "", generation: 0 }, { frameId: 6, parentFrameId: 0, documentId: "Q", url: "", generation: 0 }] } });
    const facts = await collector.collect(1, { pointer: true, thumbnails: false });
    expect(send).toHaveBeenCalledWith(1, { frameId: 4, documentId: "P" }, { type: "collect-facts", pointer: true, thumbnails: false });
    expect(send).toHaveBeenCalledWith(1, { frameId: 5 }, expect.anything());
    expect(facts.reachable).toBe(true);
    expect(facts.frames.map(frame => [frame.frameId, frame.documentId])).toEqual([[0, "A"], [4, "P"]]);
    expect(setFacts).toHaveBeenCalledWith(1, facts);
  });

  it("asks the top frame for the file the page offers, and takes only an answer that is a page's file state", async () => {
    const offer = { filename: "Clip 31.mov", url: "https://site.test/get/31" };
    const answers: unknown[] = [
      { title: "T", fileDownload: offer, fileSaveProblem: null },
      { title: "T" }, null, "Clip 31.mov",
      // Not a file state: a name that is no text, a name longer than a file name, an address that is none.
      { title: "T", fileDownload: { filename: 31, url: offer.url } },
      { title: "T", fileDownload: { filename: "x".repeat(241), url: offer.url } },
      { title: "T", fileDownload: { filename: offer.filename, url: 7 } },
      { fileDownload: offer },
    ];
    const send = vi.fn(async () => answers.shift());
    const collector = createFactsCollector({ send, store: { setFacts: vi.fn() }, frames: { frames: async () => [] } });
    expect(await collector.offeredFile(1, "https://site.test/view/31")).toEqual(offer);
    expect(send).toHaveBeenCalledWith(1, { frameId: 0 }, { type: "file-save-state", pageUrl: "https://site.test/view/31" });
    for (let left = answers.length; left > 0; left--) expect(await collector.offeredFile(1, "https://site.test/view/31")).toBeUndefined();
    send.mockRejectedValueOnce(new Error("no receiver"));
    expect(await collector.offeredFile(1, "https://site.test/view/31")).toBeUndefined();
  });

  it("notes the route generation each frame was on when its facts were read", async () => {
    const collector = createFactsCollector({ send: async (_tabId, target) => reply(target.frameId === 0), store: { setFacts: vi.fn() }, frames: { frames: async () => [
      { frameId: 0, parentFrameId: -1, documentId: "A", url: "https://site.test/watch?v=3", generation: 2 },
      { frameId: 4, parentFrameId: 0, documentId: "P", url: "https://player.test/", generation: 0 }] } });
    const facts = await collector.collect(1, { pointer: false, thumbnails: false });
    expect(facts.frames.map(frame => [frame.frameId, frame.generation])).toEqual([[0, 2], [4, 0]]);
  });

  it("reports an unreachable tab when the top frame does not answer", async () => {
    const collector = createFactsCollector({ send: async () => { throw new Error("no receiver"); }, store: { setFacts: vi.fn() },
      frames: { frames: async () => [{ frameId: 0, parentFrameId: -1, documentId: "A", url: "", generation: 0 }] } });
    expect(await collector.collect(1, { pointer: false, thumbnails: false })).toEqual({ reachable: false, frames: [] });
  });

  it("takes who a frame is from the browser, never from the frame's own answer", async () => {
    // An embedded frame answers as if it were the top document of another site.
    const forged = { ...reply(true), url: "https://bank.example/", page: { title: "Bank" } };
    const send = vi.fn(async (_tabId: number, target: { frameId: number }) => target.frameId === 0 ? reply(true) : forged);
    const collector = createFactsCollector({ send, store: { setFacts: vi.fn() }, frames: { frames: async () => [
      { frameId: 0, parentFrameId: -1, documentId: "A", url: "https://site.test/watch", generation: 0 },
      { frameId: 9, parentFrameId: 0, documentId: "AD", url: "https://ads.test/frame.html", generation: 0 }] } });
    const facts = await collector.collect(1, { pointer: false, thumbnails: false });
    expect(facts.frames.map(frame => [frame.frameId, frame.url, frame.top])).toEqual([[0, "https://site.test/watch", true], [9, "https://ads.test/frame.html", false]]);
    // Exactly one frame is the top frame: the browser's frame 0.
    expect(facts.frames.filter(frame => frame.top)).toHaveLength(1);
  });
});

describe("stored facts after a route change", () => {
  const read = (frameId: number, generation?: number): CollectedFrame => ({ ...reply(frameId === 0), top: frameId === 0, frameId, documentId: `doc-${frameId}`,
    ...(generation === undefined ? {} : { generation }) });
  const stored: TabFacts = { reachable: true, frames: [read(0, 1), read(4, 0)] };

  it("keeps the facts of every frame that is still on the route they were read on", () => {
    expect(factsOfCurrentRoutes(stored, frameId => frameId === 0 ? 1 : 0)).toBe(stored);
    expect(factsOfCurrentRoutes(null, () => 0)).toBeNull();
    // Facts stored before generations were noted are taken as they are.
    const earlier: TabFacts = { reachable: true, frames: [read(0)] };
    expect(factsOfCurrentRoutes(earlier, () => 7)).toBe(earlier);
  });

  it("leaves out a frame that changed its route since: what its players held then is not what they hold now", () => {
    const now = factsOfCurrentRoutes(stored, frameId => frameId === 0 ? 2 : 0);
    expect(now).toEqual({ reachable: true, frames: [stored.frames[1]] });
    // The embedded player moved on, the page did not.
    expect(factsOfCurrentRoutes(stored, frameId => frameId === 0 ? 1 : 3)?.frames.map(frame => frame.frameId)).toEqual([0]);
  });
});

describe("a route change inside a page", () => {
  function follower(state: { looked: boolean; shown: boolean }) {
    const reads: (() => void)[] = [];
    const read = vi.fn((_tabId: number) => new Promise<void>(resolve => { reads.push(resolve); }));
    const changed = vi.fn();
    const follow = createRouteFollower({ looked: () => state.looked, shown: () => state.shown, read, changed });
    /** Lets the read that is under way end, and what follows it run. */
    const finish = async (): Promise<void> => { reads.shift()!(); await new Promise(resolve => setTimeout(resolve)); };
    return { follow, read, changed, finish };
  }

  it("reads nothing while no popup shows the tab, however often the page changes its address: the change is announced, and the next look reads", () => {
    const { follow, read, changed } = follower({ looked: true, shown: false });
    // A player that writes its current time into the address every second, for an hour.
    for (let second = 0; second < 3600; second++) follow(7);
    expect(read).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(3600);
    expect(changed).toHaveBeenLastCalledWith(7);
  });

  it("reads nothing for a tab the user never looked at", () => {
    const { follow, read, changed } = follower({ looked: false, shown: true });
    follow(7);
    expect(read).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("reads the page again for the popup that shows the tab, and announces the change once the read is done", async () => {
    const { follow, read, changed, finish } = follower({ looked: true, shown: true });
    follow(7);
    expect(read).toHaveBeenCalledExactlyOnceWith(7);
    expect(changed).not.toHaveBeenCalled();
    await finish();
    expect(changed).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("answers a burst of route changes with one more read, not one each", async () => {
    const { follow, read, changed, finish } = follower({ looked: true, shown: true });
    for (let change = 0; change < 20; change++) follow(7);
    expect(read).toHaveBeenCalledTimes(1);
    await finish();
    expect(read).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    await finish();
    expect(read).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("stops reading when the popup closes during a read, and announces what it has", async () => {
    const state = { looked: true, shown: true };
    const { follow, read, changed, finish } = follower(state);
    follow(7);
    follow(7);
    state.shown = false;
    await finish();
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledExactlyOnceWith(7);
    // The page moves on with no popup open: nothing is read.
    follow(7);
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("announces the change when the read fails", async () => {
    const changed = vi.fn();
    const follow = createRouteFollower({ looked: () => true, shown: () => true, read: async () => { throw new Error("tab closed"); }, changed });
    follow(7);
    await new Promise(resolve => setTimeout(resolve));
    expect(changed).toHaveBeenCalledExactlyOnceWith(7);
  });
});

