import { describe, it, expect, vi } from "vitest";
import { createEngineRunner } from "../../../src/engine/runner";
import { hlsDescriptor, drmDescriptor } from "../popup/helpers/descriptors";
import type { EngineToBackgroundMessage } from "../../../src/types/messages";
import type { UserChoice } from "@savemedia/core";

function choice(): UserChoice {
  return { outputMode: "Original", filename: "x.mp4", variantId: null, audioRenditionId: null };
}

describe("engine runner — happy path", () => {
  it("posts progress, then complete when downloadJob resolves", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn(async (_d, _c, onProgress) => {
      onProgress(10, 100, "fetching");
      onProgress(100, 100, "muxing");
      return { blobUrl: "blob:x", filename: "x.mp4", checksum: "abc" };
    });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(hlsDescriptor().id, hlsDescriptor(), choice());

    const msgs = sendMessage.mock.calls.map(c => c[0]) as EngineToBackgroundMessage[];
    expect(msgs.map(m => m.type)).toEqual(["progress", "progress", "complete"]);
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
  it("wraps unknown errors into mediabunny_demux_failed", async () => {
    const sendMessage = vi.fn();
    const downloadJob = vi.fn(async () => { throw new Error("boom"); });
    const runner = createEngineRunner({ runtime: { sendMessage }, downloadJob });
    await runner.start(hlsDescriptor().id, hlsDescriptor(), choice());
    const failure = sendMessage.mock.calls[0]?.[0] as EngineToBackgroundMessage;
    if (failure.type !== "failed") throw new Error("expected failed");
    expect(failure.error.code).toBe("mediabunny_demux_failed");
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
    const downloadJob = vi.fn(async (_d, _c, _p, signal: AbortSignal) => {
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
    const downloadJob = vi.fn(async (_d, _c, _p, signal: AbortSignal) => {
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
