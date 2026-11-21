import { BROWSER_OUTPUT_LIMIT_BYTES, type DirectPlan, type JobError, type OutputContainer } from "@savemedia/core";
import { originalMediaFilename } from "../../util/filename";
import type { JobResult, ProgressFn } from "../job";
import {
  checkResponseStatus, fetchMediaRange, parseContentRange, probeMedia, rangeFailure, rangeMetadata,
  RangeRecoveryError, recoverRequest, responseHeaders, type RangeMetadata, type RetryProgress, type MediaFetch,
} from "../net/range-recovery";
import { DIRECT_MEDIA_TYPES, requireDirectVideo, validateDirectBlob } from "../verify-direct";
import { clearCheckpoint, keepCheckpoint, MAX_RESUME_BYTES, resumeIdentity, getCheckpoint, type RangeResume } from "../net/range-checkpoint";

const CHUNK_BYTES = 4 * 1024 * 1024;
const WORKERS = 4;

function retryStage(retry: Parameters<RetryProgress>[0], subject: string): string {
  const wait = retry.httpStatus ? ` in ${Math.ceil(retry.delayMs / 1000)}s · HTTP ${retry.httpStatus}` : "";
  return `Retrying ${subject}${wait} (attempt ${retry.attempt} of ${retry.maxAttempts})`;
}

export async function runDirectJob(plan: DirectPlan, onProgress: ProgressFn, signal: AbortSignal, tabId?: number): Promise<JobResult> {
  const scope = await resumeIdentity("direct:" + tabId, plan.url, plan.filename);
  const {blob, filename} = await verifiedDirectFile(plan, onProgress, signal, fetch, {
    previous: getCheckpoint(scope), interrupted: checkpoint => keepCheckpoint(scope, checkpoint),
  });
  clearCheckpoint(scope);
  return {blobUrl: URL.createObjectURL(blob), filename, checksum: ""};
}

export async function verifiedDirectFile(
  plan: DirectPlan, onProgress: ProgressFn, signal: AbortSignal, fetchFile: MediaFetch, resume?: RangeResume,
): Promise<{blob: Blob; filename: string}> {
  const connecting: RetryProgress = retry => onProgress(0, null, retryStage(retry, "connection"));
  try {
    onProgress(0, null, "probing");
    const probe = await probeMedia(fetchFile, plan.url, signal, connecting);
    const metadata = rangeMetadata(probe.headers);
    const container = requireDirectVideo(probe.bytes, probe.headers);
    const size = parseContentRange(probe.headers["content-range"])?.total ?? contentLength(probe.headers);
    if (size !== null) checkSize(size);
    const mime = DIRECT_MEDIA_TYPES[container];

    const blob = metadata
      ? await downloadRanges(probe.url, metadata, mime, onProgress, signal, fetchFile, resume)
      : await downloadFull(plan.url, container, onProgress, signal, connecting, fetchFile);
    if (size !== null && size !== blob.size) throw new RangeRecoveryError("The file size changed after the probe");

    onProgress(blob.size, blob.size, "verifying");
    await validateDirectBlob(blob, container, signal);
    signal.throwIfAborted();
    onProgress(blob.size, blob.size, "finalizing");
    return { blob, filename: originalMediaFilename(plan.filename, container) ?? plan.filename };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RangeRecoveryError || error instanceof TypeError
      || (error instanceof Error && error.name === "TimeoutError")) {
      throw rangeFailure(error, plan.url, "direct");
    }
    throw error;
  }
}

async function downloadRanges(url: string, metadata: RangeMetadata, mime: string, onProgress: ProgressFn, signal: AbortSignal, fetchFile: MediaFetch, resume?: RangeResume): Promise<Blob> {
  const count = Math.ceil(metadata.total / CHUNK_BYTES);
  const representation = resume && metadata.validatorHeader === "etag" && metadata.total <= MAX_RESUME_BYTES
    ? await resumeIdentity(String(metadata.total), url, metadata.validator) : undefined;
  const previous = resume?.previous;
  const parts: (Blob | undefined)[] = representation && previous?.representation === representation
    && previous.parts.length === count ? previous.parts.slice() : new Array(count);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const rangeSignal = controller.signal;
  let next = 0;
  let received = parts.reduce((total, part) => total + (part?.size ?? 0), 0);
  let lastUpdate = 0;
  const partial = new Map<number, number>();
  function bytesInHand(): number {
    let bytes = received;
    for (const count of partial.values()) bytes += count;
    return bytes;
  }
  onProgress(received, metadata.total, "downloading");

  async function worker(): Promise<void> {
    while (next < count) {
      rangeSignal.throwIfAborted();
      const index = next++;
      if (parts[index]) continue;
      const start = index * CHUNK_BYTES;
      const end = Math.min(start + CHUNK_BYTES, metadata.total) - 1;
      const bytes = await fetchMediaRange(url, start, end, metadata, rangeSignal, retry => {
        partial.delete(index);
        onProgress(bytesInHand(), metadata.total, retryStage(retry, `part ${index + 1} of ${count}`));
      }, fetchFile, bytes => {
        partial.set(index, bytes);
        if (performance.now() - lastUpdate >= 250) {
          lastUpdate = performance.now();
          onProgress(bytesInHand(), metadata.total, "downloading");
        }
      });
      partial.delete(index);
      parts[index] = new Blob([bytes as BlobPart]);
      received += bytes.byteLength;
      onProgress(bytesInHand(), metadata.total, "downloading");
    }
  }

  const workers = Array.from({ length: Math.min(WORKERS, count) }, () => worker());
  try {
    await Promise.all(workers);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(workers);
    if (resume && representation && received > 0 && !signal.aborted &&
      (error instanceof RangeRecoveryError && error.retryable || error instanceof TypeError ||
        error instanceof DOMException && error.name === "TimeoutError")) {
      resume.interrupted({representation, parts});
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  const blob = new Blob(parts.filter((part): part is Blob => part !== undefined), { type: mime });
  if (blob.size !== metadata.total) throw new RangeRecoveryError("Completed file has the wrong byte count");
  return blob;
}

function downloadFull(url: string, container: OutputContainer, onProgress: ProgressFn, signal: AbortSignal, onRetry: RetryProgress, fetchFile: MediaFetch): Promise<Blob> {
  return recoverRequest(async (attemptSignal, receivedBytes) => {
    const response = await fetchFile(url, { credentials: "include", cache: "no-store", signal: attemptSignal });
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
      let lastUpdate = 0;
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
        if (performance.now() - lastUpdate >= 250) {
          lastUpdate = performance.now();
          lastProgress = received;
          onProgress(received, total, "downloading");
        }
      }
      if (received < head.length) checkContainer(head.subarray(0, received), headers, container);
      if (total !== null && total !== received) throw new RangeRecoveryError("Completed file has the wrong byte count", received < total);
      if (received !== lastProgress) onProgress(received, total, "downloading");
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
