import { describe, it, expect, vi } from "vitest";
import type { StreamDescriptor, UserChoice } from "@savemedia/core";
import { parseEngineToBackground, type BackgroundToEngineMessage, type EngineToBackgroundMessage } from "../../../src/types/messages";
import { createInProcessEngineHost } from "../../../src/engine/in-process-host";
import type { JobContext, JobResult } from "../../../src/engine/job";

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
  capabilities: { directDownload: false, remuxableTo: [] },
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
      downloadJob: vi.fn((_descriptor, _choice, context: JobContext) => {
        signal = context.signal;
        return new Promise<never>(() => undefined);
      }),
    });

    const start: BackgroundToEngineMessage = { type: "start-job", streamId: descriptor.id, descriptor, choice };
    host.handleMessage(start);

    await vi.waitFor(() => expect(signal).not.toBeNull());
    host.handleMessage({ type: "cancel-job", streamId: descriptor.id });

    const capturedSignal = signal as AbortSignal | null;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("ends an image job on cancel-job, reports it as given up and is idle again", async () => {
    const sent: EngineToBackgroundMessage[] = [];
    let signal: AbortSignal | null = null;
    const host = createInProcessEngineHost({
      sendToBackground: msg => sent.push(msg),
      imageJob: (_url, jobSignal) => new Promise((_resolve, reject) => {
        signal = jobSignal;
        jobSignal.addEventListener("abort", () => reject(jobSignal.reason), { once: true });
      }),
    });
    host.handleMessage({ type: "start-image", streamId: "image:1", url: "https://cdn.example/stalls.png" });
    await vi.waitFor(() => expect(signal).not.toBeNull());
    expect(host.snapshot().idle).toBe(false);
    host.handleMessage({ type: "cancel-job", streamId: "image:1" as never });
    await vi.waitFor(() => expect(sent).toContainEqual({ type: "image-failed", streamId: "image:1", error: { code: "user_cancelled", severity: "terminal" } }));
    expect(host.snapshot().idle).toBe(true);
    expect(sent.at(-1)).toEqual({ type: "idle" });
  });

  it("reports idle only once no job runs and every output Blob was released", async () => {
    const sent: EngineToBackgroundMessage[] = [];
    let finish!: () => void;
    const host = createInProcessEngineHost({
      sendToBackground: msg => sent.push(msg),
      downloadJob: vi.fn(() => new Promise<JobResult>(resolve => { finish = () => resolve({ blobUrl: "blob:out", filename: "video.mp4", checksum: "" }); })),
    });
    host.handleMessage({ type: "start-job", streamId: descriptor.id, descriptor, choice });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish();
    await vi.waitFor(() => expect(sent.map(msg => msg.type)).toContain("complete"));
    await Promise.resolve();
    expect(sent.map(msg => msg.type)).not.toContain("idle");
    host.handleMessage({ type: "release-output", blobUrl: "blob:out" });
    expect(sent.at(-1)).toEqual({ type: "idle" });
  });

  it("passes the job's request preparation through with its stream id, once per origin", async () => {
    const prepareRequests = vi.fn(async () => undefined);
    // A long playlist: a data: key, 5,000 segments on one CDN and an init section on another host.
    const addresses = ["data:text/plain;base64,AAECAwQFBgcICQoLDA0ODw==", "https://keys.example/k",
      ...Array.from({ length: 5000 }, (_, i) => `https://seg.cdn.example/v/${i}.ts?sig=abc`), "http://init.example/init.mp4"];
    const host = createInProcessEngineHost({
      sendToBackground: () => undefined, prepareRequests,
      downloadJob: vi.fn(async (_descriptor, _choice, context: JobContext) => {
        await context.prepareRequests?.(addresses);
        return { blobUrl: "blob:x", filename: "video.mp4", checksum: "" };
      }),
    });
    host.handleMessage({ type: "start-job", streamId: descriptor.id, descriptor, choice });
    const origins = ["https://keys.example", "https://seg.cdn.example", "http://init.example"];
    await vi.waitFor(() => expect(prepareRequests).toHaveBeenCalledWith(descriptor.id, origins));
    // The message the offscreen document sends for it passes validation.
    expect(parseEngineToBackground({ type: "prepare-requests", requestId: 1, streamId: descriptor.id, urls: origins })).not.toBeNull();
  });
});
