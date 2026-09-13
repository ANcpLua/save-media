import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followActiveTab } from "../../../src/popup/App";

type Listener<T extends unknown[]> = (...args: T) => void;

/** A chrome stub with just the tab and window events the companion window uses. */
function stubChrome(ownWindowId = 99) {
  const activated: Listener<[{ tabId: number; windowId: number }]>[] = [];
  const focused: Listener<[number]>[] = [];
  const updated: Listener<[number, { status?: string }, { id: number; url?: string }]>[] = [];
  const tabs: Record<number, { id: number; windowId: number; url: string }> = {
    1: { id: 1, windowId: 10, url: "http://127.0.0.1:5174/page/direct.html" },
    2: { id: 2, windowId: 10, url: "http://127.0.0.1:5174/page/av-merge.html" },
    3: { id: 3, windowId: 20, url: "http://127.0.0.1:5174/page/hls.html" },
    9: { id: 9, windowId: ownWindowId, url: "chrome-extension://x/src/popup/index.html?tabId=1" },
  };
  const remove = <T>(list: T[]) => vi.fn((fn: T) => list.splice(list.indexOf(fn), 1));
  const chromeStub = {
    runtime: { lastError: undefined },
    windows: {
      WINDOW_ID_NONE: -1,
      getCurrent: vi.fn((cb: (w: { id: number }) => void) => cb({ id: ownWindowId })),
      onFocusChanged: { addListener: vi.fn((fn: Listener<[number]>) => focused.push(fn)), removeListener: remove(focused) },
    },
    tabs: {
      get: vi.fn((id: number, cb: (t: unknown) => void) => cb(tabs[id])),
      query: vi.fn((q: { windowId: number }, cb: (t: unknown[]) => void) =>
        cb(Object.values(tabs).filter(t => t.windowId === q.windowId).slice(-1))),
      onActivated: { addListener: vi.fn((fn: (typeof activated)[number]) => activated.push(fn)), removeListener: remove(activated) },
      onUpdated: { addListener: vi.fn((fn: (typeof updated)[number]) => updated.push(fn)), removeListener: remove(updated) },
    },
  };
  return { chromeStub, activated, focused, updated };
}

describe("detached popup window follows the active tab", () => {
  let previous: unknown;
  beforeEach(() => { previous = globalThis.chrome; });
  afterEach(() => { (globalThis as { chrome: unknown }).chrome = previous; });

  function setup(currentTab = 1) {
    const stub = stubChrome();
    (globalThis as { chrome: unknown }).chrome = stub.chromeStub;
    const start = vi.fn();
    const current = { current: currentTab as number | null };
    start.mockImplementation((id: number | null) => { current.current = id; });
    const cleanup = followActiveTab(start, current);
    return { ...stub, start, current, cleanup };
  }

  it("switches to a tab activated in the browser window", () => {
    const { activated, start } = setup();
    activated.forEach(fn => fn({ tabId: 2, windowId: 10 }));
    expect(start).toHaveBeenCalledWith(2, "http://127.0.0.1:5174/page/av-merge.html");
  });

  it("switches to the active tab of another browser window when that window gains focus", () => {
    const { focused, start } = setup();
    focused.forEach(fn => fn(20));
    expect(start).toHaveBeenCalledWith(3, "http://127.0.0.1:5174/page/hls.html");
  });

  it("ignores its own window, which has no page to inspect", () => {
    const { activated, focused, start } = setup();
    activated.forEach(fn => fn({ tabId: 9, windowId: 99 }));
    focused.forEach(fn => fn(99));
    expect(start).not.toHaveBeenCalled();
  });

  it("ignores focus leaving the browser entirely", () => {
    const { focused, start } = setup();
    focused.forEach(fn => fn(-1));
    expect(start).not.toHaveBeenCalled();
  });

  it("does not reload when the already followed tab is activated again", () => {
    const { activated, start } = setup(2);
    activated.forEach(fn => fn({ tabId: 2, windowId: 10 }));
    expect(start).not.toHaveBeenCalled();
  });

  it("re-reads the list when the followed tab finishes loading a new page", () => {
    const { updated, start } = setup(1);
    updated.forEach(fn => fn(1, { status: "loading" }, { id: 1 }));
    expect(start).not.toHaveBeenCalled();
    updated.forEach(fn => fn(1, { status: "complete" }, { id: 1, url: "http://127.0.0.1:5174/page/low.html" }));
    expect(start).toHaveBeenCalledWith(1, "http://127.0.0.1:5174/page/low.html");
  });

  it("ignores page loads in tabs it is not following", () => {
    const { updated, start } = setup(1);
    updated.forEach(fn => fn(2, { status: "complete" }, { id: 2, url: "x" }));
    expect(start).not.toHaveBeenCalled();
  });

  it("removes every listener on cleanup", () => {
    const { activated, focused, updated, cleanup } = setup();
    cleanup();
    expect(activated).toHaveLength(0);
    expect(focused).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });
});
