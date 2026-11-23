import { describe, it, expect, vi } from "vitest";
import { createEngineRunner } from "../../../src/engine/runner";
import { hlsDescriptor, drmDescriptor } from "../popup/helpers/descriptors";
import type { EngineToBackgroundMessage } from "../../../src/types/messages";
import type { JobContext } from "../../../src/engine/job";
import type { UserChoice } from "@savemedia/core";

function choice(): UserChoice {
  return { outputMode: "Original", filename: "x.mp4", variantId: null, audioRenditionId: null };
}

describe("engine runner — happy path", () => {
  it("posts progress, then complete when downloadJob resolves", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn(async (_d, _c, { onProgress }: JobContext) => {
      onProgress({ stage: { kind: "segment", index: 1, count: 10 }, bytesWritten: 10, bytesTotal: 100 });
      onProgress({ stage: { kind: "finalizing" }, bytesWritten: 100, bytesTotal: 100 });
      return { blobUrl: "blob:x", filename: "x.mp4", checksum: "abc" };
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(hlsDescriptor().id, hlsDescriptor(), choice());

    const msgs = sendMessage.mock.calls.map(c => c[0]) as EngineToBackgroundMessage[];
    expect(msgs.map(m => m.type)).toEqual(["progress", "progress", "complete"]);
    expect(msgs[0]).toEqual({ type: "progress", streamId: hlsDescriptor().id, stage: { kind: "segment", index: 1, count: 10 },
      bytesWritten: 10, bytesTotal: 100 });
    const last = msgs[2];
    expect(last?.type === "complete" && last.blobUrl).toBe("blob:x");
  });

  it("refuses DRM-tagged descriptors before invoking downloadJob", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn();
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(drmDescriptor().id, drmDescriptor(), choice());
    expect(downloadJob).not.toHaveBeenCalled();
    const msgs = sendMessage.mock.calls.map(c => c[0]) as EngineToBackgroundMessage[];
    expect(msgs).toHaveLength(1);
    if (msgs[0]?.type !== "failed") throw new Error("expected failed");
    expect(msgs[0].error.code).toBe("cdm_required");
  });
});

describe("engine runner — failure paths", () => {
  it("carries the bytes a failed save retained as structured data on its failure", async () => {
    const sendMessage = vi.fn();
    const retained = { bytes: 58013, total: 194120, expiresAt: 1_900_000_000_000 };
    const downloadJob = vi.fn(async (_d, _c, { onRetained }: JobContext) => {
      onRetained?.(retained);
      throw { code: "server_busy", severity: "terminal" as const, phase: "direct" as const, url: "https://x", httpStatus: 503 };
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(hlsDescriptor().id, hlsDescriptor(), choice());
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ type: "failed", error: { code: "server_busy" }, retained });
  });

  it("wraps unknown errors into a neutral engine failure", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn(async () => { throw new Error("boom"); });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(hlsDescriptor().id, hlsDescriptor(), choice());
    const failure = sendMessage.mock.calls[0]?.[0] as EngineToBackgroundMessage;
    if (failure.type !== "failed") throw new Error("expected failed");
    expect(failure.error.code).toBe("engine_job_failed");
  });

  it("translates AbortError into user_cancelled", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn(async () => {
      throw new DOMException("user-cancelled", "AbortError");
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(hlsDescriptor().id, hlsDescriptor(), choice());
    const failure = sendMessage.mock.calls[0]?.[0] as EngineToBackgroundMessage;
    if (failure.type !== "failed") throw new Error("expected failed");
    expect(failure.error.code).toBe("user_cancelled");
  });

  it("preserves a structured JobError thrown by downloadJob", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn(async () => {
      throw {
        code: "segment_budget_exhausted",
        severity: "terminal" as const,
        failedSegments: [1, 2],
        totalSegments: 100,
      };
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(hlsDescriptor().id, hlsDescriptor(), choice());
    const failure = sendMessage.mock.calls[0]?.[0] as EngineToBackgroundMessage;
    if (failure.type !== "failed") throw new Error("expected failed");
    expect(failure.error.code).toBe("segment_budget_exhausted");
  });
});

describe("engine runner — cancellation + lifecycle", () => {
  it("propagates cancel via AbortController and de-registers the job", async () => {
    const sendMessage = vi.fn();
    let receivedSignal: AbortSignal | undefined;
    const downloadJob = vi.fn(async (_d, _c, { signal }: JobContext) => {
      receivedSignal = signal;
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
      throw new Error("unreachable");
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    const id = hlsDescriptor().id;
    const promise = runner.start(id, hlsDescriptor(), choice());
    await Promise.resolve();
    expect(runner.active()).toContain(id);
    runner.cancel(id);
    await promise;
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
    expect(runner.active()).not.toContain(id);
  });

  it("ignores cancel for an unknown job", () => {
    const runner = createEngineRunner({ runtime: { sendMessage: vi.fn() }, downloadJob: vi.fn() });
    expect(() => runner.cancel(hlsDescriptor().id)).not.toThrow();
  });

  it("ignores duplicate start for an in-flight job id", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn(async (_d, _c, { signal }: JobContext) => {
      await new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      return { blobUrl: "", filename: "", checksum: "" };
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    const id = hlsDescriptor().id;
    const p1 = runner.start(id, hlsDescriptor(), choice());
    await Promise.resolve();
    const p2 = runner.start(id, hlsDescriptor(), choice());
    runner.cancel(id);
    await Promise.all([p1, p2]);
    expect(downloadJob).toHaveBeenCalledTimes(1);
  });
});

describe("engine runner — where a job may send requests", () => {
  it("fails a job that a public page points into the user's network, before the request is prepared or sent", async () => {
    const sendMessage = vi.fn();
    const prepareRequests = vi.fn(async () => undefined);
    const requested: string[] = [];
    const downloadJob = vi.fn(async (_d, _c, context: JobContext) => {
      await context.prepareRequests?.(["https://cdn.example/seg1.ts"]);
      requested.push("seg1");
      // The playlist of a public page names its key on the user's router.
      await context.prepareRequests?.(["http://192.168.1.1/key.bin"]);
      requested.push("key");
      return { blobUrl: "blob:x", filename: "x.mp4", checksum: "abc" };
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob, prepareRequests });
    await runner.start(hlsDescriptor().id, { ...hlsDescriptor(), pageUrl: "https://news.example/story" }, choice());
    expect(requested).toEqual(["seg1"]);
    expect(prepareRequests).toHaveBeenCalledTimes(1);
    const failed = (sendMessage.mock.calls.map(c => c[0]) as EngineToBackgroundMessage[]).find(message => message.type === "failed");
    expect(failed).toMatchObject({ error: { code: "private_network_target", host: "192.168.1.1" } });
  });

  it("requests a local server for a public page when the job was given its origin: the browser was answered from there", async () => {
    const sendMessage = vi.fn();
    const prepareRequests = vi.fn(async () => undefined);
    const downloadJob = vi.fn(async (_d, _c, context: JobContext) => {
      await context.prepareRequests?.(["https://media.corp-portal.net/v/media.m3u8", "https://media.corp-portal.net/v/seg1.ts"]);
      // A key on another local server, which the browser was not at for this page.
      await context.prepareRequests?.(["https://keys.corp-portal.net/k", "http://10.0.0.1/key.bin"]);
      return { blobUrl: "blob:x", filename: "x.mp4", checksum: "abc" };
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob, prepareRequests });
    await runner.start(hlsDescriptor().id, { ...hlsDescriptor(), pageUrl: "https://corp-portal.net/watch" }, choice(), undefined, ["http://192.168.1.10"]);
    expect(prepareRequests).toHaveBeenCalledTimes(1);
    expect((sendMessage.mock.calls.map(c => c[0]) as EngineToBackgroundMessage[]).find(message => message.type === "failed"))
      .toMatchObject({ error: { code: "private_network_target", host: "10.0.0.1" } });

    sendMessage.mockClear();
    const literal = vi.fn(async (_d, _c, context: JobContext) => {
      await context.prepareRequests?.(["http://192.168.1.10/hls/media.m3u8", "http://192.168.1.10/hls/seg1.ts"]);
      return { blobUrl: "blob:x", filename: "x.mp4", checksum: "abc" };
    });
    const allowed = createEngineRunner({ runtime: { sendMessage }, downloadJob: literal, prepareRequests });
    await allowed.start(hlsDescriptor().id, { ...hlsDescriptor(), pageUrl: "https://news.example/story" }, choice(), undefined, ["http://192.168.1.10"]);
    expect((sendMessage.mock.calls.map(c => c[0]) as EngineToBackgroundMessage[]).at(-1)?.type).toBe("complete");
  });

  it("lets a page on the user's own network use its own servers", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn(async (_d, _c, context: JobContext) => {
      await context.prepareRequests?.(["http://192.168.1.20:8096/v/seg1.ts"]);
      return { blobUrl: "blob:x", filename: "x.mp4", checksum: "abc" };
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(hlsDescriptor().id, { ...hlsDescriptor(), pageUrl: "http://192.168.1.20:8096/web/" }, choice());
    expect((sendMessage.mock.calls.map(c => c[0]) as EngineToBackgroundMessage[]).at(-1)?.type).toBe("complete");
  });
});

