import { describe, expect, it, vi } from "vitest";
import { createNativeHostClient, type NativePortLike } from "../../../src/native/host-client";
import type { HostPong } from "../../../src/types/native";

function fakePort() {
  const messageListeners: ((msg: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const port: NativePortLike & { emit: (msg: unknown) => void; drop: () => void; sent: unknown[] } = {
    sent: [],
    postMessage: vi.fn(msg => { port.sent.push(msg); }),
    disconnect: vi.fn(),
    onMessage: { addListener: fn => { messageListeners.push(fn); } },
    onDisconnect: { addListener: fn => { disconnectListeners.push(fn); } },
    emit: msg => messageListeners.forEach(l => l(msg)),
    drop: () => disconnectListeners.forEach(l => l()),
  };
  return port;
}

const pong: HostPong = {
  type: "pong", hostVersion: "1.0.0", protocolVersion: 1,
  ytdlp: { found: true, version: "2026.08.01", path: "/opt/homebrew/bin/yt-dlp" },
  ffmpeg: { found: true, version: "7.1", path: "/opt/homebrew/bin/ffmpeg" },
  outputDir: "/Users/me/Downloads",
};

describe("native host client", () => {
  it("ping resolves with the pong and closes the port", async () => {
    const port = fakePort();
    const client = createNativeHostClient({ connectNative: () => port });
    const p = client.ping();
    expect(port.sent).toEqual([{ type: "ping" }]);
    port.emit(pong);
    await expect(p).resolves.toEqual(pong);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it("ping resolves null when the host is not installed (port disconnects)", async () => {
    const port = fakePort();
    const client = createNativeHostClient({ connectNative: () => port, lastError: () => ({ message: "Specified native messaging host not found." }) });
    const p = client.ping();
    port.drop();
    await expect(p).resolves.toBeNull();
  });

  it("ping resolves null when connectNative throws (permission not granted)", async () => {
    const client = createNativeHostClient({ connectNative: () => { throw new Error("nativeMessaging permission missing"); } });
    await expect(client.ping()).resolves.toBeNull();
  });

  it("download streams progress and completion for its own id only", () => {
    const port = fakePort();
    const client = createNativeHostClient({ connectNative: () => port });
    const onProgress = vi.fn(); const onComplete = vi.fn(); const onFailed = vi.fn();
    client.download(
      { id: "j1", pageUrl: "https://example.com/v", quality: "best", cookiesFromBrowser: "edge", outputDir: null },
      { onProgress, onComplete, onFailed },
    );
    expect(port.sent[0]).toMatchObject({ type: "download", id: "j1", pageUrl: "https://example.com/v", quality: "best", cookiesFromBrowser: "edge" });
    port.emit({ type: "progress", id: "other", phase: "downloading", downloadedBytes: 1, totalBytes: 2, percent: 50, speedBytesPerSec: null, etaSeconds: null });
    port.emit({ type: "progress", id: "j1", phase: "downloading", downloadedBytes: 10, totalBytes: 100, percent: 10, speedBytesPerSec: 5, etaSeconds: 18 });
    port.emit({ type: "complete", id: "j1", filename: "clip.mp4", path: "/Users/me/Downloads/clip.mp4", bytes: 100 });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ filename: "clip.mp4" }));
    expect(onFailed).not.toHaveBeenCalled();
    expect(port.disconnect).toHaveBeenCalled();
  });

  it("download reports host_unavailable when the port drops mid-job", () => {
    const port = fakePort();
    const client = createNativeHostClient({ connectNative: () => port, lastError: () => ({ message: "Native host has exited." }) });
    const onFailed = vi.fn();
    client.download(
      { id: "j2", pageUrl: "https://example.com/v", quality: "720", cookiesFromBrowser: null, outputDir: null },
      { onProgress: vi.fn(), onComplete: vi.fn(), onFailed },
    );
    port.drop();
    expect(onFailed).toHaveBeenCalledWith({ type: "failed", id: "j2", code: "host_unavailable", message: "Native host has exited." });
  });

  it("cancel posts a cancel frame and ignores it after completion", () => {
    const port = fakePort();
    const client = createNativeHostClient({ connectNative: () => port });
    const cancel = client.download(
      { id: "j3", pageUrl: "https://example.com/v", quality: "best", cookiesFromBrowser: null, outputDir: null },
      { onProgress: vi.fn(), onComplete: vi.fn(), onFailed: vi.fn() },
    );
    cancel();
    expect(port.sent.at(-1)).toEqual({ type: "cancel", id: "j3" });
    port.emit({ type: "failed", id: "j3", code: "cancelled", message: "cancelled" });
    cancel();
    expect(port.sent.filter(m => (m as { type: string }).type === "cancel")).toHaveLength(1);
  });

  it("drops malformed host frames", () => {
    const port = fakePort();
    const client = createNativeHostClient({ connectNative: () => port });
    const onFailed = vi.fn(); const onComplete = vi.fn();
    client.download(
      { id: "j4", pageUrl: "https://example.com/v", quality: "best", cookiesFromBrowser: null, outputDir: null },
      { onProgress: vi.fn(), onComplete, onFailed },
    );
    port.emit({ type: "complete", id: "j4" });
    port.emit({ type: "failed", id: "j4", code: "not-a-code", message: "x" });
    port.emit("garbage");
    expect(onComplete).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
