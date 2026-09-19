import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { App } from "../../../src/popup/App";
import { directDescriptor } from "./helpers/descriptors";
import type { BackgroundToPopupMessage } from "../../../src/types/messages";

describe("popup App", () => {
  it("shows a discovery failure and lets the user check the page again", () => {
    const url = "https://cdn.example/stream?secret=private-token";
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type?: string }, cb?: (resp: BackgroundToPopupMessage | undefined) => void) => {
        if (msg.type === "list") cb?.({ type: "descriptors", tabId: 1, descriptors: [], failures: [{ url,
          error: { code: "server_busy", severity: "terminal", phase: "direct", url, httpStatus: 503 },
        }] });
        else if (msg.type === "rescan") cb?.({ type: "descriptors", tabId: 1, descriptors: [directDescriptor()], failures: [] });
        else cb?.(undefined);
      }) as never,
    );
    render(<App />);
    expect(screen.getByText(/server is busy/i)).toBeTruthy();
    expect(screen.queryByText(/no media detected/i)).toBeNull();
    expect(screen.getByText("cdn.example")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private-token");
    fireEvent.click(screen.getByRole("button", { name: "Check page again" }));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "rescan", tabId: 1 }, expect.any(Function));
    expect(screen.queryByText(/server is busy/i)).toBeNull();
    expect(screen.getByText(/clip name/i)).toBeTruthy();
  });

  it("restores an engine failure when the popup is reopened", () => {
    const descriptor = directDescriptor();
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type?: string }, cb?: (resp: BackgroundToPopupMessage | undefined) => void) => {
        if (msg.type === "list") cb?.({ type: "descriptors", tabId: 1, descriptors: [descriptor], statuses: {
          [descriptor.id]: { phase: "failed", error: { code: "server_busy", severity: "terminal", phase: "direct", url: "https://cdn.example/clip.mp4", httpStatus: 503 } },
        } });
        else cb?.(undefined);
      }) as never,
    );
    const first = render(<App />);
    expect(screen.getByTestId("job-error").textContent).toMatch(/server is busy/i);
    first.unmount();
    render(<App />);
    expect(screen.getByTestId("job-error").textContent).toMatch(/server is busy/i);
  });

  it("renders the empty state when no descriptors are present", () => {
    render(<App skipFetch />);
    expect(screen.getByText(/no media detected/i)).toBeTruthy();
  });

  it("queries the active tab and asks background for the descriptor list", () => {
    render(<App />);
    expect(globalThis.chrome.tabs.query).toHaveBeenCalled();
    const sent = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(c => c[0]);
    expect(sent).toContainEqual({ type: "list", tabId: 1 });
  });

  it("renders the descriptors returned by background", () => {
    vi.mocked(globalThis.chrome.runtime.sendMessage).mockImplementation(
      ((msg: { type?: string }, cb?: (resp: BackgroundToPopupMessage | undefined) => void) => {
        if (msg?.type === "list") cb?.({ type: "descriptors", tabId: 1, descriptors: [directDescriptor()] });
        else cb?.(undefined);
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
