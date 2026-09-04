import { describe, expect, it, vi } from "vitest";
import {
  discoverPageMediaForTab,
  downloadBestForActiveTab,
  downloadBestForTab,
  registerDownloadBestCommand,
  type DownloadBestDeps,
} from "../../../src/background/download-best";
import { MAIN_BRIDGE_TAG, type ContentDiscoveryResponse } from "../../../src/types/messages";
import { directDescriptor } from "../popup/helpers/descriptors";
import type { LocalJobView } from "../../../src/types/messages";

function localJob(): LocalJobView {
  return {
    id: "local-1", pageUrl: "https://example.com/watch", tabId: 42, phase: "probing",
    percent: null, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null,
    filename: null, failure: null,
  };
}

function deps(overrides: Partial<DownloadBestDeps> = {}): DownloadBestDeps {
  const base: DownloadBestDeps = {
    tabs: {
      query: vi.fn(async () => [{ id: 42, url: "https://example.com/watch" }]),
      sendMessage: vi.fn((_tabId, _msg, cb) => cb({
        pageUrl: "https://example.com/watch",
        urls: ["https://cdn.example.com/master.m3u8"],
      })),
    },
    runtime: {
      lastError: vi.fn(() => null),
      sendMessage: vi.fn(),
    },
    router: {
      startBestDownload: vi.fn(async () => ({ kind: "started", streamId: directDescriptor().id }) as const),
    },
    handleCapture: vi.fn(async () => undefined),
    showHotkeyFeedback: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe("download-best command helpers", () => {
  it("asks the content bridge for embedded URLs and replays them as capture messages", async () => {
    const d = deps();

    await discoverPageMediaForTab(d, 42, "https://fallback.example/");

    expect(d.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      { type: "discover-page-media" },
      expect.any(Function),
    );
    expect(d.handleCapture).toHaveBeenCalledWith(42, {
      type: "capture",
      payload: {
        [MAIN_BRIDGE_TAG]: true,
        kind: "media-source",
        url: "https://cdn.example.com/master.m3u8",
        pageUrl: "https://example.com/watch",
      },
    });
  });

  it("uses the tab URL when the bridge response has no page URL", async () => {
    const d = deps({
      tabs: {
        query: vi.fn(async () => [{ id: 42, url: "https://example.com/watch" }]),
        sendMessage: vi.fn((_tabId, _msg, cb) => cb({
          pageUrl: "",
          urls: ["https://cdn.example.com/master.m3u8"],
        })),
      },
    });

    await discoverPageMediaForTab(d, 42, "https://fallback.example/");

    const msg = vi.mocked(d.handleCapture).mock.calls[0]?.[1];
    expect(msg?.payload.pageUrl).toBe("https://fallback.example/");
  });

  it("ignores tabs where no bridge is available", async () => {
    const d = deps({
      runtime: {
        lastError: vi.fn(() => ({ message: "receiving end does not exist" })),
        sendMessage: vi.fn(),
      },
      tabs: {
        query: vi.fn(async () => [{ id: 42, url: "https://example.com/watch" }]),
        sendMessage: vi.fn((_tabId, _msg, cb) => cb(undefined as ContentDiscoveryResponse | undefined)),
      },
    });

    await discoverPageMediaForTab(d, 42, "https://fallback.example/");

    expect(d.handleCapture).not.toHaveBeenCalled();
  });

  it("runs discovery before starting the best tab download", async () => {
    const d = deps();

    await downloadBestForActiveTab(d);

    expect(d.handleCapture).toHaveBeenCalledTimes(1);
    expect(d.router.startBestDownload).toHaveBeenCalledWith(42);
  });

  it("runs download-best for a content-script hotkey without querying the active tab", async () => {
    const d = deps();

    await downloadBestForTab(d, 77, "https://example.com/hotkey");

    expect(d.tabs.query).not.toHaveBeenCalled();
    expect(d.tabs.sendMessage).toHaveBeenCalledWith(
      77,
      { type: "discover-page-media" },
      expect.any(Function),
    );
    expect(d.router.startBestDownload).toHaveBeenCalledWith(77);
  });

  it("forwards startBestDownload failures to popup listeners", async () => {
    const descriptor = directDescriptor();
    const error = { code: "browser_download_failed", severity: "terminal", reason: "ENOSPC", filename: "clip.mp4" } as const;
    const d = deps({
      router: {
        startBestDownload: vi.fn(async () => ({
          kind: "failed",
          streamId: descriptor.id,
          error,
        }) as const),
      },
    });

    await downloadBestForActiveTab(d);

    expect(d.runtime.sendMessage).toHaveBeenCalledWith(
      {
        type: "job-failed",
        streamId: descriptor.id,
        error,
      },
      expect.any(Function),
    );
    expect(d.showHotkeyFeedback).toHaveBeenCalledWith(42, "failed", expect.any(String));
  });

  it("shows no-media feedback instead of failing silently when the page has nothing downloadable", async () => {
    const d = deps({
      router: {
        startBestDownload: vi.fn(async () => ({ kind: "no-media" }) as const),
      },
    });

    await downloadBestForActiveTab(d);

    expect(d.showHotkeyFeedback).toHaveBeenCalledWith(42, "no-media", expect.any(String));
    expect(d.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("registers only the download-best command name", async () => {
    let listener: (command: string) => void = () => undefined;
    const d = deps();
    registerDownloadBestCommand({ onCommand: { addListener: fn => { listener = fn; } } }, d);

    listener("other-command");
    expect(d.tabs.query).not.toHaveBeenCalled();

    listener("download-best");
    expect(d.tabs.query).toHaveBeenCalledTimes(1);
    // The listener fires downloadBestForActiveTab without awaiting it; let it
    // finish inside this test so mock resets can't strip its deps mid-flight.
    await vi.waitFor(() => expect(d.showHotkeyFeedback).toHaveBeenCalled());
  });

  it("hands the page URL to the local downloader when the page has nothing the engine can save", async () => {
    const localFallback = vi.fn(async () => localJob());
    const d = deps({
      router: { startBestDownload: vi.fn(async () => ({ kind: "no-media" }) as const) },
      localFallback,
    });

    await downloadBestForActiveTab(d);

    expect(localFallback).toHaveBeenCalledWith("https://example.com/watch", 42);
    expect(d.showHotkeyFeedback).toHaveBeenCalledWith(42, "delegated", expect.any(String));
  });

  it("falls back for browser-only limitations such as DASH", async () => {
    const localFallback = vi.fn(async () => localJob());
    const d = deps({
      router: {
        startBestDownload: vi.fn(async () => ({
          kind: "failed",
          streamId: directDescriptor().id,
          error: { code: "dash_unsupported", severity: "terminal", manifestUrl: "https://cdn.example.com/m.mpd" },
        }) as const),
      },
      localFallback,
    });

    await downloadBestForActiveTab(d);

    expect(localFallback).toHaveBeenCalled();
    expect(d.showHotkeyFeedback).toHaveBeenCalledWith(42, "delegated", expect.any(String));
    expect(d.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("never delegates protected media to the local downloader", async () => {
    const localFallback = vi.fn(async () => localJob());
    const d = deps({
      router: {
        startBestDownload: vi.fn(async () => ({
          kind: "failed",
          streamId: directDescriptor().id,
          error: { code: "encrypted_media_detected", severity: "terminal", detectedVia: ["eme-hook"], keySystem: "com.widevine.alpha" },
        }) as const),
      },
      localFallback,
    });

    await downloadBestForActiveTab(d);

    expect(localFallback).not.toHaveBeenCalled();
    expect(d.showHotkeyFeedback).toHaveBeenCalledWith(42, "failed", expect.any(String));
  });

  it("reports no-media normally when the local downloader declines", async () => {
    const localFallback = vi.fn(async () => null);
    const d = deps({
      router: { startBestDownload: vi.fn(async () => ({ kind: "no-media" }) as const) },
      localFallback,
    });

    await downloadBestForActiveTab(d);

    expect(d.showHotkeyFeedback).toHaveBeenCalledWith(42, "no-media", expect.any(String));
  });
});
