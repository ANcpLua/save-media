import { BROWSER_OUTPUT_LIMIT_BYTES, type DirectPlan } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";
import { fetchMediaRange, probeMedia, rangeMetadata, rangeFailure, RangeRecoveryError } from "../net/range-recovery";
import { validateDirectBlob } from "../verify-direct";

const CHUNK_BYTES = 4 * 1024 * 1024;
const WORKERS = 4;

/** Recovery for direct files whose discovery probe confirmed range support. */
export async function runDirectJob(plan: DirectPlan, onProgress: ProgressFn, signal: AbortSignal): Promise<JobResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    onProgress(0, null, "probing");
    const probe = await probeMedia(fetch, plan.url, controller.signal, retry => {
      onProgress(0, null, `Retrying connection (${retry.attempt}/${retry.maxAttempts})`);
    });
    const metadata = rangeMetadata(probe.headers);
    if (!metadata) throw new RangeRecoveryError("Server no longer supplies validated byte ranges");
    if (metadata.total >= BROWSER_OUTPUT_LIMIT_BYTES) {
      throw { code: "output_too_large_for_browser", severity: "terminal", estimatedBytes: metadata.total, limitBytes: BROWSER_OUTPUT_LIMIT_BYTES };
    }

    const count = Math.ceil(metadata.total / CHUNK_BYTES);
    const parts: Blob[] = new Array(count);
    let next = 0;
    let received = 0;
    onProgress(0, metadata.total, "downloading");
    async function worker(): Promise<void> {
      while (next < count) {
        controller.signal.throwIfAborted();
        const index = next++;
        const start = index * CHUNK_BYTES;
        const end = Math.min(start + CHUNK_BYTES, metadata!.total) - 1;
        const bytes = await fetchMediaRange(plan.url, start, end, metadata!, controller.signal, retry => {
          onProgress(received, metadata!.total, `Retrying part ${index + 1}/${count} (${retry.attempt}/${retry.maxAttempts})`);
        });
        controller.signal.throwIfAborted();
        parts[index] = new Blob([bytes as BlobPart]);
        received += bytes.byteLength;
        onProgress(received, metadata!.total, "downloading");
      }
    }
    const workers = Array.from({ length: Math.min(WORKERS, count) }, () => worker());
    try {
      await Promise.all(workers);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(workers);
      throw error;
    }
    const blob = new Blob(parts, { type: probe.headers["content-type"] ?? "application/octet-stream" });
    if (received !== metadata.total || blob.size !== metadata.total) throw new RangeRecoveryError("Completed file has the wrong byte count");
    onProgress(received, metadata.total, "verifying");
    await validateDirectBlob(blob, controller.signal);
    controller.signal.throwIfAborted();
    onProgress(received, metadata.total, "finalizing");
    return { blobUrl: URL.createObjectURL(blob), filename: plan.filename, checksum: "" };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RangeRecoveryError || error instanceof TypeError
      || (error instanceof Error && error.name === "TimeoutError")) {
      throw rangeFailure(error, plan.url, "direct");
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
