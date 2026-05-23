import { describe, it, expect, vi } from "vitest";
import type { StreamDescriptor, UserChoice } from "@savemedia/core";
import type { BackgroundToEngineMessage, EngineToBackgroundMessage } from "../../../src/types/messages";
import { createInProcessEngineHost } from "../../../src/engine/in-process-host";

const descriptor = {
  id: "stream-1",
  tabId: 1,
  pageUrl: "https://example.test/page.html",
  detectedAt: 1,
  source: { kind: "hls-manifest", manifestUrl: "https://example.test/master.m3u8", type: "master" },
  protocol: "hls",
  container: "mpegts",
  codecs: [],
  variants: [],
  drm: null,
  capabilities: { directDownload: false, drmBlocked: false },
} as unknown as StreamDescriptor;

const choice: UserChoice = {
  outputMode: "Original",
  filename: "video.mp4",
  variantId: null,
  audioRenditionId: null,
};

describe("in-process engine host", () => {
  it("routes start-job to the engine runner and sends completion back to background", async () => {
    const sent: EngineToBackgroundMessage[] = [];
    const host = createInProcessEngineHost({
      sendToBackground: msg => sent.push(msg),
      downloadJob: vi.fn(async () => ({ blobUrl: "blob:ok", filename: "video.mp4", checksum: "" })),
    });

    host.handleMessage({ type: "start-job", streamId: descriptor.id, descriptor, choice });

    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: "complete",
        streamId: descriptor.id,
        blobUrl: "blob:ok",
        filename: "video.mp4",
        checksum: "",
      });
    });
  });

  it("routes cancel-job to the active runner signal", async () => {
    let signal: AbortSignal | null = null;
    const host = createInProcessEngineHost({
      sendToBackground: () => undefined,
      downloadJob: vi.fn((_descriptor, _choice, _progress, abortSignal) => {
        signal = abortSignal;
        return new Promise(() => undefined);
      }),
    });

    const start: BackgroundToEngineMessage = { type: "start-job", streamId: descriptor.id, descriptor, choice };
    host.handleMessage(start);

    await vi.waitFor(() => expect(signal).not.toBeNull());
    host.handleMessage({ type: "cancel-job", streamId: descriptor.id });

    const capturedSignal = signal as AbortSignal | null;
    expect(capturedSignal?.aborted).toBe(true);
  });
});
