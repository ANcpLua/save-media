// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://example.com/watch"}
import { beforeEach, describe, expect, it, vi } from "vitest";

// bridge.ts is the ISOLATED-world entry. Importing it registers the
// runtime.onMessage listener that renders the Alt+S feedback toast.

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
let listener: Listener | null = null;

// The chrome mock is installed per test in tests/setup.ts (beforeEach), so
// the bridge is imported on the first test's mock and its listener kept.
beforeEach(async () => {
  if (listener) return;
  vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => {
    listener = fn as Listener;
  });
  await import("../../../src/content/bridge");
});

function toastText(): string | null {
  const host = document.querySelector('[data-savemedia="feedback"]');
  return host?.shadowRoot?.textContent ?? null;
}

describe("in-page hotkey feedback toast", () => {
  it("renders a toast for the first message and again for the next one", () => {
    expect(listener).not.toBeNull();
    listener!({ type: "hotkey-feedback", outcome: "started", detail: "Saving best quality" }, {}, () => undefined);
    expect(toastText()).toContain("Saving");
    expect(toastText()).toContain("Saving best quality");

    listener!({ type: "hotkey-feedback", outcome: "failed", detail: "Protected media" }, {}, () => undefined);
    expect(toastText()).toContain("Not saved");
    expect(toastText()).toContain("Protected media");
    expect(document.querySelectorAll('[data-savemedia="feedback"]')).toHaveLength(1);
  });

  it("labels completion as Saved and ignores malformed messages", () => {
    listener!({ type: "hotkey-feedback", outcome: "complete", detail: "clip.mp4" }, {}, () => undefined);
    expect(toastText()).toContain("Saved");
    const before = toastText();
    listener!({ type: "hotkey-feedback", outcome: "bogus", detail: "x" }, {}, () => undefined);
    expect(toastText()).toBe(before);
  });

  it("removes the toast after its timeout", () => {
    vi.useFakeTimers();
    listener!({ type: "hotkey-feedback", outcome: "no-media", detail: "Nothing here" }, {}, () => undefined);
    expect(toastText()).toContain("Nothing to save");
    vi.advanceTimersByTime(2_400 + 300);
    expect(document.querySelector('[data-savemedia="feedback"]')).toBeNull();
    vi.useRealTimers();
  });
});
