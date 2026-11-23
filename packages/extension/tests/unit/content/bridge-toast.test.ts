// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://example.com/watch"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECONNECT_HINT, TOAST_LABELS, TOAST_OUTCOMES, toastDuration, toastUrgency } from "../../../src/ui/toast-text";

// bridge.ts is the ISOLATED-world entry. Importing it registers the
// runtime.onMessage listener that renders the Alt+S feedback toast. Each
// test imports it afresh, so each starts without a toast host.

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
let listener: Listener;
let frames: FrameRequestCallback[] = [];

/** Run what the page would run in its next animation frame. */
function nextFrame(): void {
  const due = frames;
  frames = [];
  for (const frame of due) frame(0);
}

beforeEach(async () => {
  document.body.innerHTML = "";
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.resetModules();
  vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => { listener = fn as Listener; });
  await import("../../../src/content/bridge");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of ["showPopover", "hidePopover"] as const) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
});

const feedback = (outcome: string, detail: string) => listener({ type: "hotkey-feedback", outcome, detail }, {}, () => undefined);
const hosts = () => document.querySelectorAll('[data-savemedia="feedback"]');
const root = () => hosts()[0]!.shadowRoot!;
const part = (selector: string) => root().querySelector(selector)!;
const statusRegion = () => root().querySelector('[role="status"]')!;
const alertRegion = () => root().querySelector('[role="alert"]')!;

describe("in-page hotkey feedback toast", () => {
  it("builds one host with two empty live regions and a card that is hidden from assistive technology", () => {
    feedback("started", "Best quality · 12.0 MB");
    expect(hosts()).toHaveLength(1);
    expect(root().querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(root().querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(root().querySelectorAll("[aria-live]")).toHaveLength(1);
    // The regions exist before their text does: that is what makes the first announcement reliable.
    expect(statusRegion().textContent).toBe("");
    expect(alertRegion().textContent).toBe("");
    expect(part(".t").getAttribute("aria-hidden")).toBe("true");
    expect(part(".t").hasAttribute("role")).toBe(false);
    expect(part(".k").textContent).toBe("Saving");
    expect(part(".d").textContent).toBe("Best quality · 12.0 MB");
    expect(part(".t").textContent).toBe("SavingBest quality · 12.0 MB");
  });

  it("announces a result politely and a failure as an alert, in the frame after it is shown", () => {
    feedback("complete", "clip.mp4");
    nextFrame();
    expect(part(".t").classList.contains("show")).toBe(true);
    expect(statusRegion().textContent).toBe("Saved: clip.mp4");
    expect(alertRegion().textContent).toBe("");

    feedback("failed", "Protected video");
    // Both regions are emptied first, so nothing stale is read out.
    expect(statusRegion().textContent).toBe("");
    nextFrame();
    expect(alertRegion().textContent).toBe("Not saved: Protected video");
    expect(statusRegion().textContent).toBe("");
    expect(hosts()).toHaveLength(1);
  });

  it("announces the same words again when they are shown again", () => {
    feedback("waiting", "The page has not loaded the video yet. Start playback, then try again.");
    nextFrame();
    const text = "Not ready: The page has not loaded the video yet. Start playback, then try again.";
    expect(statusRegion().textContent).toBe(text);
    feedback("waiting", "The page has not loaded the video yet. Start playback, then try again.");
    expect(statusRegion().textContent).toBe("");
    nextFrame();
    expect(statusRegion().textContent).toBe(text);
  });

  it("labels the state and never repeats it in the detail, for every outcome it knows", () => {
    for (const outcome of TOAST_OUTCOMES) {
      feedback(outcome, "detail");
      expect(part(".k").textContent).toBe(TOAST_LABELS[outcome]);
      nextFrame();
      const region = toastUrgency(outcome) === "assertive" ? alertRegion() : statusRegion();
      expect(region.textContent).toBe(`${TOAST_LABELS[outcome]}: detail`);
    }
    expect(toastUrgency("failed")).toBe("assertive");
    expect(TOAST_OUTCOMES.filter(outcome => toastUrgency(outcome) === "assertive")).toEqual(["failed"]);
    expect(TOAST_LABELS.asked).toBe("Already saved");
    expect(TOAST_LABELS.cancelled).toBe("Cancelled");
    expect(new Set(Object.values(TOAST_LABELS)).has("Local downloader")).toBe(false);
  });

  it("ignores a message that is not one of its outcomes", () => {
    feedback("complete", "clip.mp4");
    feedback("bogus", "x");
    listener({ type: "hotkey-feedback", outcome: "complete" }, {}, () => undefined);
    expect(part(".k").textContent).toBe("Saved");
    expect(part(".d").textContent).toBe("clip.mp4");
  });

  it("hides the card and empties the regions after its time, and keeps the host for the next toast", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    feedback("no-media", "No media detected on this page.");
    nextFrame();
    expect(part(".t").classList.contains("show")).toBe(true);
    vi.advanceTimersByTime(toastDuration("no-media") - 1);
    expect(part(".t").classList.contains("show")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(part(".t").classList.contains("show")).toBe(false);
    expect(statusRegion().textContent).toBe("");
    expect(alertRegion().textContent).toBe("");
    expect(hosts()).toHaveLength(1);
    const host = hosts()[0];
    feedback("complete", "next.mp4");
    expect(hosts()[0]).toBe(host);
  });

  it("stays longer when it asks the user to do something", () => {
    expect(toastDuration("failed")).toBe(8_000);
    expect(toastDuration("waiting")).toBe(8_000);
    expect(toastDuration("asked")).toBe(8_000);
    expect(toastDuration("preparing")).toBe(12_000);
    for (const outcome of ["started", "delegated", "complete", "no-media", "cancelled"] as const) expect(toastDuration(outcome)).toBe(4_000);
  });

  it("is a manual popover where the browser has them, and is opened again when the page goes fullscreen while it shows", () => {
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    Object.assign(HTMLElement.prototype, { showPopover, hidePopover });
    feedback("started", "This video");
    const host = hosts()[0] as HTMLElement;
    expect(host.getAttribute("popover")).toBe("manual");
    expect(host.parentNode).toBe(document.body);
    expect(showPopover).toHaveBeenCalledTimes(1);
    expect(hidePopover).not.toHaveBeenCalled();
    // Opening it again moves it above an element that went fullscreen after it.
    vi.spyOn(host, "matches").mockReturnValue(true);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(hidePopover).toHaveBeenCalledTimes(1);
    expect(showPopover).toHaveBeenCalledTimes(2);
    expect(hidePopover.mock.invocationCallOrder[0]!).toBeLessThan(showPopover.mock.invocationCallOrder[1]!);
  });

  it("does not move for a fullscreen change after the toast has gone", () => {
    const showPopover = vi.fn();
    Object.assign(HTMLElement.prototype, { showPopover, hidePopover: vi.fn() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    feedback("complete", "clip.mp4");
    vi.advanceTimersByTime(toastDuration("complete"));
    showPopover.mockClear();
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(showPopover).not.toHaveBeenCalled();
  });

  it("without popovers, moves into a fullscreen element that can hold it, and never into a video", () => {
    const player = document.createElement("div");
    const video = document.createElement("video");
    document.body.append(player, video);
    const fullscreen = (element: Element | null) => Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => element });

    feedback("started", "This video");
    const host = hosts()[0]!;
    expect(host.hasAttribute("popover")).toBe(false);
    expect(host.parentNode).toBe(document.body);

    fullscreen(player);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.parentNode).toBe(player);

    fullscreen(video);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.parentNode).toBe(document.body);

    fullscreen(null);
    feedback("complete", "clip.mp4");
    expect(host.parentNode).toBe(document.body);
    expect(hosts()).toHaveLength(1);
    delete (document as unknown as Record<string, unknown>)["fullscreenElement"];
  });

  it("tells a tab whose extension was reloaded under it to reload, in the catalogue's words", () => {
    expect(RECONNECT_HINT).toBe("Reload this page to reconnect savemedia.");
  });
});
