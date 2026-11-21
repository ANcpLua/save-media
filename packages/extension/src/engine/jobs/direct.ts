import { BROWSER_OUTPUT_LIMIT_BYTES, type DirectPlan, type JobError, type OutputContainer } from "@savemedia/core";
import { originalMediaFilename } from "../../util/filename";
import type { JobResult, ProgressFn } from "../job";
import {
  checkResponseStatus, fetchMediaRange, parseContentRange, probeMedia, rangeFailure, rangeMetadata,
  RangeRecoveryError, recoverRequest, responseHeaders, type RangeMetadata, type RetryProgress,
} from "../net/range-recovery";
import { DIRECT_MEDIA_TYPES, requireDirectVideo, validateDirectBlob } from "../verify-direct";

const CHUNK_BYTES = 4 * 1024 * 1024;
const WORKERS = 4;

export async function runDirectJob(plan: DirectPlan, onProgress: ProgressFn, signal: AbortSignal): Promise<JobResult> {
  const connecting: RetryProgress = retry => onProgress(0, null, `Retrying connection (${retry.attempt}/${retry.maxAttempts})`);
  try {
    onProgress(0, null, "probing");
    const probe = await probeMedia(fetch, plan.url, signal, connecting);
    const metadata = rangeMetadata(probe.headers);
    const container = requireDirectVideo(probe.bytes, probe.headers);
    const size = parseContentRange(probe.headers["content-range"])?.total ?? contentLength(probe.headers);
    if (size !== null) checkSize(size);
    const mime = DIRECT_MEDIA_TYPES[container];

    const blob = metadata
      ? await downloadRanges(probe.url, metadata, mime, onProgress, signal)
      : await downloadFull(plan.url, container, onProgress, signal, connecting);

    onProgress(blob.size, blob.size, "verifying");
    await validateDirectBlob(blob, container, signal);
    signal.throwIfAborted();
    onProgress(blob.size, blob.size, "finalizing");
    return { blobUrl: URL.createObjectURL(blob), filename: originalMediaFilename(plan.filename, container) ?? plan.filename, checksum: "" };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RangeRecoveryError || error instanceof TypeError
      || (error instanceof Error && error.name === "TimeoutError")) {
      throw rangeFailure(error, plan.url, "direct");
    }
    throw error;
  }
}

async function downloadRanges(url: string, metadata: RangeMetadata, mime: string, onProgress: ProgressFn, signal: AbortSignal): Promise<Blob> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const rangeSignal = controller.signal;
  const count = Math.ceil(metadata.total / CHUNK_BYTES);
  const parts: BlobPart[] = new Array(count);
  let next = 0;
  let received = 0;
  onProgress(0, metadata.total, "downloading");

  async function worker(): Promise<void> {
    while (next < count) {
      rangeSignal.throwIfAborted();
      const index = next++;
      const start = index * CHUNK_BYTES;
      const end = Math.min(start + CHUNK_BYTES, metadata.total) - 1;
      const bytes = await fetchMediaRange(url, start, end, metadata, rangeSignal, retry => {
        onProgress(received, metadata.total, `Retrying part ${index + 1}/${count} (${retry.attempt}/${retry.maxAttempts})`);
      });
      parts[index] = new Blob([bytes as BlobPart]);
      received += bytes.byteLength;
      onProgress(received, metadata.total, "downloading");
    }
  }

  const workers = Array.from({ length: Math.min(WORKERS, count) }, () => worker());
  try {
    await Promise.all(workers);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(workers);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  const blob = new Blob(parts, { type: mime });
  if (blob.size !== metadata.total) throw new RangeRecoveryError("Completed file has the wrong byte count");
  return blob;
}

function downloadFull(url: string, container: OutputContainer, onProgress: ProgressFn, signal: AbortSignal, onRetry: RetryProgress): Promise<Blob> {
  return recoverRequest(async (attemptSignal, receivedBytes) => {
    const response = await fetch(url, { credentials: "include", cache: "no-store", signal: attemptSignal });
    const reader = response.body?.getReader();
    try {
      checkResponseStatus(response, url);
      const headers = responseHeaders(response);
      if (!reader || response.status !== 200 || headers["content-range"]) {
        throw new RangeRecoveryError("The server did not return a complete file");
      }
      const total = contentLength(headers);
      if (total !== null) checkSize(total);
      const parts: BlobPart[] = [];
      const head = new Uint8Array(4096);
      let received = 0;
      let lastProgress = 0;
      onProgress(0, total, "downloading");
      while (true) {
        attemptSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes();
        if (received < head.length) {
          head.set(value.subarray(0, head.length - received), received);
          if (received + value.byteLength >= head.length) checkContainer(head, headers, container);
        }
        received += value.byteLength;
        checkSize(received);
        parts.push(value as BlobPart);
        if (received - lastProgress >= 1024 * 1024) {
          lastProgress = received;
          onProgress(received, total, "downloading");
        }
      }
      if (received < head.length) checkContainer(head.subarray(0, received), headers, container);
      if (total !== null && total !== received) throw new RangeRecoveryError("Completed file has the wrong byte count", received < total);
      return new Blob(parts, { type: DIRECT_MEDIA_TYPES[container] });
    } finally {
      try { await reader?.cancel(); } catch { /* Already consumed or interrupted. */ }
      reader?.releaseLock();
    }
  }, signal, 3, onRetry);
}

function checkContainer(bytes: Uint8Array, headers: Readonly<Record<string, string>>, expected: OutputContainer): void {
  if (requireDirectVideo(bytes, headers) !== expected) {
    throw { code: "verification_container", severity: "terminal", probeError: "The file type changed between requests" } satisfies JobError;
  }
}

function contentLength(headers: Readonly<Record<string, string>>): number | null {
  // Fetch decodes HTTP content encodings before exposing the body.
  if (headers["content-encoding"] && headers["content-encoding"] !== "identity") return null;
  const value = headers["content-length"];
  return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function checkSize(size: number): void {
  if (size >= BROWSER_OUTPUT_LIMIT_BYTES) {
    throw { code: "output_too_large_for_browser", severity: "terminal", estimatedBytes: size, limitBytes: BROWSER_OUTPUT_LIMIT_BYTES } satisfies JobError;
  }
}
