import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { App } from "../../../src/popup/App";
import { directDescriptor } from "./helpers/descriptors";
import type { BackgroundToPopupMessage } from "../../../src/types/messages";

describe("popup App", () => {
  it("renders the empty state when no descriptors are present", () => {
    render(<App skipFetch />);
    expect(screen.getByText(/no media detected/i)).toBeTruthy();
  });

  it("queries the active tab and asks background for the descriptor list", () => {
    render(<App />);
    expect(globalThis.chrome.tabs.query).toHaveBeenCalled();
    const sendArg = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls[0]?.[0];
    expect(sendArg).toEqual({ type: "list", tabId: 1 });
  });

  it("renders the descriptors returned by background", () => {
    vi.mocked(globalThis.chrome.runtime.sendMessage).mockImplementationOnce(
      ((_msg: unknown, cb?: (resp: BackgroundToPopupMessage) => void) => {
        cb?.({ type: "descriptors", tabId: 1, descriptors: [directDescriptor()] });
      }) as never,
    );
    render(<App />);
    expect(screen.getByText(/clip name/i)).toBeTruthy();
  });

  it("refreshes descriptors when background broadcasts the active tab list", () => {
    let listener: ((msg: BackgroundToPopupMessage) => void) | null = null;
    vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => {
      listener = fn as (msg: BackgroundToPopupMessage) => void;
    });
    render(<App />);
    expect(listener).not.toBeNull();

    act(() => {
      listener!({
        type: "descriptors",
        tabId: 1,
        descriptors: [directDescriptor({ title: "fresh list" })],
      });
    });

    expect(screen.getByText(/fresh list/i)).toBeTruthy();
  });

  it("updates job state when background broadcasts progress/failed/complete messages", () => {
    let listener: ((msg: BackgroundToPopupMessage) => void) | null = null;
    vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => {
      listener = fn as (msg: BackgroundToPopupMessage) => void;
    });
    render(<App initialDescriptors={[directDescriptor()]} skipFetch />);
    expect(listener).not.toBeNull();

    act(() => {
      listener!({
        type: "job-progress",
        streamId: directDescriptor().id,
        bytesWritten: 10,
        bytesTotal: 100,
        phase: "fetching",
      });
    });
    expect(screen.getByTestId("progress")).toBeTruthy();

    act(() => {
      listener!({
        type: "job-failed",
        streamId: directDescriptor().id,
        error: { code: "manifest_404", severity: "terminal", url: "https://x", httpStatus: 404 },
      });
    });
    expect(screen.getByTestId("job-error")).toBeTruthy();
  });
});
