import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearToolbarNotice, forgetToolbarTab, importToolbar, onToolbarNotices, onToolbarPainted, paintToolbarNotice, resetStaleToolbar, resetToolbarState,
  flashToolbar, showToolbarNotice, toolbarBusy, updateToolbarProgress, type ToolbarNotice,
} from "../../../src/background/toolbar-progress";

const DEFAULT = { default_icon: { 16: "icons/icon-16.png" }, default_title: "savemedia" };

function action() {
  const calls = { setTitle: vi.fn(async (_details: { tabId: number; title: string }) => undefined), setIcon: vi.fn(async (_details: { tabId: number; path?: unknown }) => undefined) };
  Object.assign(chrome.action, calls);
  Object.assign(chrome.runtime, { getManifest: () => ({ action: DEFAULT }) });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no artwork in tests"); }));
  return calls;
}

describe("the toolbar button of a tab", () => {
  beforeEach(() => { resetToolbarState(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows a transfer while it runs and goes back to the default when it ends, per tab", () => {
    const calls = action();
    const painted: (readonly number[])[] = [];
    onToolbarPainted(tabs => painted.push(tabs));
    updateToolbarProgress(1, "stream-a", { stage: { kind: "downloading" }, bytesWritten: 5, bytesTotal: 10 });
    updateToolbarProgress(2, "stream-b", { stage: { kind: "starting" } });
    expect(toolbarBusy(1)).toBe(true);
    const titleOf = (tabId: number): string => calls.setTitle.mock.calls.filter(([details]) => details.tabId === tabId).at(-1)![0].title;
    expect(titleOf(1)).toBe("savemedia · Downloading · 50% of 10 B");
    expect(titleOf(2)).toBe("savemedia · Starting");
    updateToolbarProgress(1, "stream-a", null);
    expect(toolbarBusy(1)).toBe(false);
    expect(toolbarBusy(2)).toBe(true);
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 1, title: "savemedia" });
    expect(calls.setIcon).toHaveBeenLastCalledWith({ tabId: 1, path: DEFAULT.default_icon });
    expect(painted).toEqual([[1], [1, 2], [2]]);
    forgetToolbarTab(2);
    expect(painted.at(-1)).toEqual([]);
  });

  it("names the product in lowercase and says how far a save is: a share of a known size, bytes received, or several saves at once", () => {
    const calls = action();
    const title = (): string => calls.setTitle.mock.calls.at(-1)![0].title;
    updateToolbarProgress(1, "a", { stage: { kind: "downloading" }, bytesWritten: 540 * 1024 ** 2, bytesTotal: 1.2 * 1024 ** 3 });
    expect(title()).toBe("savemedia · Downloading · 43% of 1.20 GB");
    updateToolbarProgress(1, "a", { stage: { kind: "downloading" }, bytesWritten: 12 * 1024 ** 2, bytesTotal: null });
    expect(title()).toBe("savemedia · Downloading · 12.0 MB received");
    updateToolbarProgress(1, "a", { stage: { kind: "segment", index: 3, count: 4 } });
    expect(title()).toBe("savemedia · Downloading · 75%");
    updateToolbarProgress(1, "a", { stage: { kind: "verifying" } });
    expect(title()).toBe("savemedia · Checking the finished file");
    updateToolbarProgress(1, "a", { stage: { kind: "downloading" }, bytesWritten: 25, bytesTotal: 100 });
    updateToolbarProgress(1, "b", { stage: { kind: "downloading" }, bytesWritten: 75, bytesTotal: 100 });
    expect(title()).toBe("savemedia · 2 saves in progress · 50%");
    updateToolbarProgress(1, "b", { stage: { kind: "starting" } });
    expect(title()).toBe("savemedia · 2 saves in progress");
    for (const [details] of calls.setTitle.mock.calls) expect(details.title).not.toMatch(/SaveMedia|segment|\d+\/\d+/);
  });

  it("shows the result of an Alt+S press for a moment, and gives the button back only if nothing else took it", () => {
    const calls = action();
    const end = flashToolbar(8, { text: "✓", color: "#16a34a" }, "savemedia · Saved: clip.mp4");
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 8, text: "✓" });
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 8, title: "savemedia · Saved: clip.mp4" });
    expect(end!()).toBe(true);
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 8, title: "savemedia" });
    // A later press replaces an earlier one: the earlier one's end changes nothing.
    const first = flashToolbar(8, { text: "…", color: "#2563eb" }, "savemedia · Checking: clip.mp4");
    const second = flashToolbar(8, { text: "↓", color: "#16a34a" }, "savemedia · Saving: Best quality");
    expect(first!()).toBe(false);
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 8, title: "savemedia · Saving: Best quality" });
    // A transfer that started meanwhile keeps the button.
    updateToolbarProgress(8, "stream-a", { stage: { kind: "starting" } });
    expect(second!()).toBe(false);
    expect(toolbarBusy(8)).toBe(true);
    // A running transfer and a notice are never painted over.
    expect(flashToolbar(8, { text: "✓", color: "#16a34a" }, "x")).toBeNull();
    showToolbarNotice(9, "savemedia · Reload this page so savemedia can see it.");
    expect(flashToolbar(9, { text: "✓", color: "#16a34a" }, "x")).toBeNull();
  });

  it("after a worker restart, puts the default back on tabs that were painted and have no transfer any more", () => {
    const calls = action();
    // Tabs 4 and 5 showed progress when the worker stopped. The save of tab 5 was restored; the one of tab 4 is gone.
    importToolbar([4, 5]);
    updateToolbarProgress(5, "stream-restored", { stage: { kind: "starting" } });
    calls.setTitle.mockClear();
    calls.setIcon.mockClear();
    resetStaleToolbar();
    expect(calls.setTitle).toHaveBeenCalledExactlyOnceWith({ tabId: 4, title: "savemedia" });
    expect(calls.setIcon).toHaveBeenCalledExactlyOnceWith({ tabId: 4, path: DEFAULT.default_icon });
    expect(toolbarBusy(5)).toBe(true);
    // Nothing is left to reset the second time.
    resetStaleToolbar();
    expect(calls.setTitle).toHaveBeenCalledOnce();
  });

  it("carries a notice until the tab shows another page, and never over a running transfer", () => {
    const calls = action();
    showToolbarNotice(3, "savemedia · Reload this page so savemedia can see it.");
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 3, text: "!" });
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 3, title: "savemedia · Reload this page so savemedia can see it." });
    clearToolbarNotice(3);
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 3, title: "savemedia" });
    updateToolbarProgress(6, "stream-a", { stage: { kind: "starting" } });
    calls.setTitle.mockClear();
    showToolbarNotice(6, "notice");
    clearToolbarNotice(6);
    expect(calls.setTitle).not.toHaveBeenCalled();
    expect(toolbarBusy(6)).toBe(true);
  });

  it("keeps a notice through a worker restart, through a badge update and through a transfer, until the tab shows another page", () => {
    const calls = action();
    const stored: (readonly ToolbarNotice[])[] = [];
    onToolbarNotices(notices => stored.push(notices));
    const TITLE = "savemedia · Reload this page so savemedia can see it.";
    showToolbarNotice(3, TITLE);
    showToolbarNotice(3, TITLE);
    expect(stored).toEqual([[{ tabId: 3, title: TITLE }]]);

    // The worker restarts: the notice comes back from what was stored, and the stale-button sweep leaves it in place.
    resetToolbarState();
    importToolbar([3], stored.at(-1));
    vi.mocked(chrome.action.setBadgeText).mockClear();
    calls.setTitle.mockClear();
    resetStaleToolbar();
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 3, title: TITLE });
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 3, text: "!" });
    // Whoever is about to write the tab's count asks first, and the notice is painted instead.
    expect(paintToolbarNotice(3)).toBe(true);
    expect(paintToolbarNotice(4)).toBe(false);

    // A transfer takes the button, and gives it back to the notice.
    updateToolbarProgress(3, "stream-a", { stage: { kind: "starting" } });
    expect(paintToolbarNotice(3)).toBe(false);
    updateToolbarProgress(3, "stream-a", null);
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 3, title: TITLE });
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 3, text: "!" });

    // The tab shows another page.
    onToolbarNotices(notices => stored.push(notices));
    clearToolbarNotice(3);
    expect(stored.at(-1)).toEqual([]);
    expect(calls.setTitle).toHaveBeenLastCalledWith({ tabId: 3, title: "savemedia" });
    expect(paintToolbarNotice(3)).toBe(false);
  });
});
