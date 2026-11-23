import { describe, expect, it, vi } from "vitest";
import { createFrameTracker, type NavigationApi } from "../../../src/background/frames";
import { createTabMediaStore } from "../../../src/background/tab-media";
import { REMOVED_FRAME } from "../../../src/util/tab-media-state";

type Listener = Parameters<NavigationApi["onCommitted"]["addListener"]>[0];

function setup(allFrames: Awaited<ReturnType<NavigationApi["getAllFrames"]>> = []) {
  let committed!: Listener;
  let history!: Listener;
  let failed!: Parameters<NonNullable<NavigationApi["onErrorOccurred"]>["addListener"]>[0];
  const api: NavigationApi = {
    getAllFrames: vi.fn(async () => allFrames),
    onCommitted: { addListener: listener => { committed = listener; } },
    onHistoryStateUpdated: { addListener: listener => { history = listener; } },
    onErrorOccurred: { addListener: listener => { failed = listener; } },
  };
  const store = createTabMediaStore();
  const on = { topDocument: vi.fn(), frameDocument: vi.fn(), navigated: vi.fn() };
  const tracker = createFrameTracker(api, store, on);
  return { tracker, store, on, commit: (details: Parameters<Listener>[0]) => committed(details), push: (details: Parameters<Listener>[0]) => history(details),
    fail: (details: Parameters<Listener>[0], error: string) => failed({ ...details, error }) };
}

const top = (documentId: string, url: string, extra: object = {}) => ({ tabId: 1, frameId: 0, url, documentId, documentLifecycle: "active", ...extra });

describe("frame tracker", () => {
  it("a top commit with a new document resets the tab; the same document does not", () => {
    const { on, commit, tracker } = setup();
    commit(top("A", "https://site.test/a"));
    commit(top("A", "https://site.test/a"));
    expect(on.topDocument).toHaveBeenCalledTimes(1);
    expect(on.topDocument).toHaveBeenCalledWith(1, "https://site.test/a");
    expect(tracker.frameUrl(1, 0)).toBe("https://site.test/a");
    expect(tracker.documentId(1, 0)).toBe("A");
  });

  it("a top-level navigation that failed leaves the browser's error page: the old document is gone and the tab is marked", () => {
    const { on, commit, fail, tracker, store } = setup();
    // The real reset, as the service worker does it for a new top document.
    on.topDocument.mockImplementation((tabId: number) => store.reset(tabId));
    commit(top("A", "https://site.test/a"));
    store.noteReceived(1, "https://cdn.test/a.mp4", null);
    expect(tracker.loadFailed(1)).toBe(false);
    fail(top("E", "https://site.test/offline"), "net::ERR_INTERNET_DISCONNECTED");
    expect(tracker.loadFailed(1)).toBe(true);
    expect(on.topDocument).toHaveBeenLastCalledWith(1, "https://site.test/offline");
    expect(tracker.frameUrl(1, 0)).toBe("https://site.test/offline");
    expect(store.received(1, "https://cdn.test/a.mp4")).toBeNull();
    // The reload that works is a new document: the mark goes with the reset.
    commit(top("B", "https://site.test/offline"));
    expect(tracker.loadFailed(1)).toBe(false);
    expect(on.topDocument).toHaveBeenCalledTimes(3);
  });

  it("a navigation the browser dropped, a failed frame and a failed prerender leave the page as it is", () => {
    const { on, commit, fail, tracker } = setup();
    commit(top("A", "https://site.test/a"));
    // A link that became a download, or a load the user stopped.
    fail(top("A", "https://site.test/file.zip"), "net::ERR_ABORTED");
    fail(top("A", "https://site.test/file.zip"), "NS_BINDING_ABORTED");
    fail({ tabId: 1, frameId: 5, url: "https://ads.test/frame", documentId: "F", documentLifecycle: "active" }, "net::ERR_BLOCKED_BY_CLIENT");
    fail(top("P", "https://site.test/next", { documentLifecycle: "prerender" }), "net::ERR_FAILED");
    fail({ ...top("X", "https://site.test/x"), tabId: -1 }, "net::ERR_FAILED");
    expect(tracker.loadFailed(1)).toBe(false);
    expect(tracker.loadFailed(7)).toBe(false);
    expect(on.topDocument).toHaveBeenCalledTimes(1);
    expect(tracker.frameUrl(1, 0)).toBe("https://site.test/a");
  });

  it("A, then B, then back to A from the back-forward cache: each is a new top document", () => {
    const { on, commit } = setup();
    commit(top("A", "https://site.test/a"));
    commit(top("B", "https://site.test/b"));
    commit(top("A", "https://site.test/a"));
    expect(on.topDocument.mock.calls.map(call => call[1])).toEqual(["https://site.test/a", "https://site.test/b", "https://site.test/a"]);
  });

  it("a subframe commit reports only that frame", () => {
    const { on, commit, tracker } = setup();
    commit(top("A", "https://site.test/a"));
    commit({ tabId: 1, frameId: 5, url: "https://player.test/1", documentId: "P1", documentLifecycle: "active" });
    commit({ tabId: 1, frameId: 5, url: "https://player.test/2", documentId: "P2", documentLifecycle: "active" });
    expect(on.topDocument).toHaveBeenCalledTimes(1);
    expect(on.frameDocument.mock.calls).toEqual([[1, 5], [1, 5]]);
    expect(tracker.documentId(1, 5)).toBe("P2");
  });

  it("a route change raises the frame's generation for a new path or query, never for a fragment", () => {
    const { on, commit, push, tracker } = setup();
    commit(top("A", "https://site.test/watch?v=1"));
    push(top("A", "https://site.test/watch?v=1#t=30"));
    expect(tracker.generation(1, 0)).toBe(0);
    expect(on.navigated).not.toHaveBeenCalled();
    push(top("A", "https://site.test/watch?v=2"));
    push(top("A", "https://site.test/other"));
    expect(tracker.generation(1, 0)).toBe(2);
    expect(on.navigated).toHaveBeenCalledTimes(2);
    expect(tracker.frameUrl(1, 0)).toBe("https://site.test/other");
    // A new document starts its routes again.
    commit(top("B", "https://site.test/b"));
    expect(tracker.generation(1, 0)).toBe(0);
  });

  it("ignores documents that are prerendering, cached or being removed", () => {
    const { on, commit, push } = setup();
    commit(top("A", "https://site.test/a"));
    commit(top("P", "https://site.test/next", { documentLifecycle: "prerender" }));
    commit(top("C", "https://site.test/old", { documentLifecycle: "cached" }));
    push(top("P", "https://site.test/next?x=1", { documentLifecycle: "pending_deletion" }));
    expect(on.topDocument).toHaveBeenCalledTimes(1);
    expect(on.navigated).not.toHaveBeenCalled();
  });

  it("a message from the top frame of an unrecorded document is a new top document: a prerendered page was activated", () => {
    const { on, commit, tracker } = setup();
    commit(top("A", "https://site.test/a"));
    tracker.noteSender(1, 0, "A", "https://site.test/a");
    expect(on.topDocument).toHaveBeenCalledTimes(1);
    tracker.noteSender(1, 0, "P", "https://site.test/next");
    expect(on.topDocument).toHaveBeenLastCalledWith(1, "https://site.test/next");
    expect(tracker.documentId(1, 0)).toBe("P");
  });

  it("knows a late message of a replaced document from a message of the one shown now", () => {
    const { commit, tracker } = setup();
    expect(tracker.isCurrent(1, 0, "A")).toBe(true);
    commit(top("A", "https://site.test/a"));
    commit({ tabId: 1, frameId: 5, url: "https://player.test/1", documentId: "P1", documentLifecycle: "active" });
    commit(top("B", "https://site.test/b"));
    expect(tracker.isCurrent(1, 0, "A")).toBe(false);
    expect(tracker.isCurrent(1, 0, "B")).toBe(true);
    // The new top document dropped the old frame records: an unknown frame counts as current.
    expect(tracker.isCurrent(1, 5, "P1")).toBe(true);
    commit({ tabId: 1, frameId: 5, url: "https://player.test/2", documentId: "P2", documentLifecycle: "active" });
    expect(tracker.isCurrent(1, 5, "P1")).toBe(false);
    expect(tracker.isCurrent(1, 5, null)).toBe(true);
  });

  it("after a service worker restart the first message is adopted without a reset", () => {
    const { on, tracker } = setup();
    tracker.noteSender(1, 0, "A", "https://site.test/a");
    tracker.noteSender(1, 4, "F", "https://player.test/");
    expect(on.topDocument).not.toHaveBeenCalled();
    expect(tracker.frameUrl(1, 0)).toBe("https://site.test/a");
    expect(tracker.frameUrl(1, 4)).toBe("https://player.test/");
  });

  it("lists the active frames with their generations, and falls back to the top frame when the browser lists none", async () => {
    const { tracker, commit, push } = setup([
      { frameId: 0, parentFrameId: -1, url: "https://site.test/a?v=2", documentId: "A", documentLifecycle: "active" },
      { frameId: 5, parentFrameId: 0, url: "https://player.test/", documentId: "P", documentLifecycle: "active" },
      { frameId: 9, parentFrameId: 0, url: "https://site.test/next", documentId: "N", documentLifecycle: "prerender" },
    ]);
    commit(top("A", "https://site.test/a"));
    push(top("A", "https://site.test/a?v=2"));
    expect(await tracker.frames(1)).toEqual([
      { frameId: 0, parentFrameId: -1, documentId: "A", url: "https://site.test/a?v=2", generation: 1 },
      { frameId: 5, parentFrameId: 0, documentId: "P", url: "https://player.test/", generation: 0 },
    ]);
    expect(await setup(null).tracker.frames(3)).toEqual([{ frameId: 0, parentFrameId: -1, documentId: null, url: "", generation: 0 }]);
  });

  it("a frame the page removed: its record names no document any more, and its media is cleared like a replaced document's", async () => {
    const live = [{ frameId: 0, parentFrameId: -1, url: "https://site.test/a", documentId: "A", documentLifecycle: "active" },
      { frameId: 5, parentFrameId: 0, url: "https://player.test/1", documentId: "P1", documentLifecycle: "active" }];
    const { tracker, store, on, commit } = setup(live);
    commit(top("A", "https://site.test/a"));
    commit({ tabId: 1, frameId: 5, url: "https://player.test/1", documentId: "P1", documentLifecycle: "active", parentFrameId: 0 });
    on.frameDocument.mockClear();
    await tracker.frames(1);
    expect(on.frameDocument).not.toHaveBeenCalled();
    expect(store.tab(1).frames[5]).toMatchObject({ documentId: "P1", parent: 0 });
    // The page swaps the player's frame for a new one: the browser lists frame 6 and no longer frame 5.
    live.splice(1, 1, { frameId: 6, parentFrameId: 0, url: "https://player.test/2", documentId: "P2", documentLifecycle: "active" });
    await tracker.frames(1);
    expect(on.frameDocument).toHaveBeenCalledTimes(1);
    expect(on.frameDocument).toHaveBeenCalledWith(1, 5);
    expect(tracker.documentId(1, 5)).toBe(REMOVED_FRAME);
    expect(tracker.isCurrent(1, 5, "P1")).toBe(false);
    expect(store.tab(1).frames[6]).toMatchObject({ documentId: "P2", parent: 0 });
    // Looking again reports nothing twice.
    await tracker.frames(1);
    expect(on.frameDocument).toHaveBeenCalledTimes(1);
  });

  it("a page restored from the back-forward cache keeps what the browser received for it", () => {
    const { store, commit, on } = setup();
    on.topDocument.mockImplementation((tabId: number) => store.reset(tabId));
    commit(top("A", "https://site.test/a"));
    store.noteReceived(1, "https://cdn.test/a.m3u8", null, 0);
    commit(top("B", "https://site.test/b"));
    expect(store.received(1, "https://cdn.test/a.m3u8")).toBeNull();
    commit(top("A", "https://site.test/a"));
    expect(store.received(1, "https://cdn.test/a.m3u8")).toEqual({ ip: null, frameId: 0 });
  });
});
