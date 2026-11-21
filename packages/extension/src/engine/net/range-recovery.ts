// Adapted from video-rescue/internal/rescue/downloader.go (MIT, ANcpLua).
// See licenses/video-rescue-MIT.txt. Browser adaptation: bounded probes,
// per-range retries and representation checks; no filesystem/native host.
import { isCertificateError, type JobError } from "@savemedia/core";
import { BrowserFetchError, classifyNetworkFailure, type NetworkPhase } from "./error-classification";

export interface RangeRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly httpStatus?: number;
}
export type RetryProgress = (retry: RangeRetry) => void;

export interface ProbeResponse {
  readonly status: number;
  readonly url?: string;
  readonly headers: { forEach(cb: (value: string, key: string) => void): void };
  readonly body?: ReadableStream<Uint8Array> | null;
  clone(): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface ProbeInit {
  readonly credentials: "include";
  readonly cache?: "no-store";
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export type MediaFetch = (url: string, init: ProbeInit) => Promise<Response>;
export type ProbeFetch = (url: string, init: ProbeInit) => Promise<ProbeResponse>;

export interface ContentRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

export interface RangeMetadata {
  readonly total: number;
  readonly validator: string;
  readonly validatorHeader: "etag" | "last-modified";
}

export class RangeRecoveryError extends Error {
  constructor(message: string, readonly retryable = false, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RangeRecoveryError";
  }
}

class InsecureMediaRedirect extends RangeRecoveryError {}

/** Translate transport failures without exposing signed URLs or raw fetch errors. */
export function rangeFailure(error: unknown, url: string, phase: NetworkPhase): JobError {
  if (error instanceof InsecureMediaRedirect) {
    return { code: "insecure_media_redirect", severity: "terminal" };
  }
  if (error instanceof BrowserFetchError && isCertificateError(error.diagnostic.code)) {
    return { code: "tls_certificate_rejected", severity: "terminal", phase, browserDiagnostic: error.diagnostic };
  }
  const status = error instanceof RangeRecoveryError ? error.status : undefined;
  let origin = "";
  try { origin = new URL(url).origin; } catch { /* No origin for a malformed URL. */ }
  const detail = error instanceof Error && error.name === "TimeoutError"
    ? "The request timed out after retries." : "The media request could not be completed.";
  const classified = classifyNetworkFailure({ url: origin, status: status ?? "network-error", attemptsRemaining: 0,
    retryAfterSeconds: null, detail }, phase, origin);
  if (status !== undefined && classified) return classified;
  if (error instanceof RangeRecoveryError) {
    return { code: "engine_job_failed", severity: "terminal", at: phase === "manifest" ? "manifest" : "segment",
      detail: status === undefined ? error.message : `Media request returned HTTP ${status}. Reload the page and check again.` };
  }
  return { code: "network_unreachable", severity: "terminal", phase, url: origin, detail,
    ...(error instanceof BrowserFetchError ? { browserDiagnostic: error.diagnostic } : {}) };
}

export function parseContentRange(value: string | undefined): ContentRange | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number) as [number, number, number];
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

export function rangeMetadata(headers: Readonly<Record<string, string>>): RangeMetadata | null {
  const range = parseContentRange(headers["content-range"]);
  if (!range || range.start !== 0 || range.end > 4095) return null;
  if (headers["content-encoding"] && headers["content-encoding"] !== "identity") return null;
  const etag = headers.etag?.trim();
  if (etag && /^"[^"\r\n]*"$/.test(etag)) return { total: range.total, validator: etag, validatorHeader: "etag" };
  const modified = headers["last-modified"]?.trim();
  if (modified && Number.isFinite(Date.parse(modified))) {
    return { total: range.total, validator: modified, validatorHeader: "last-modified" };
  }
  return null;
}

export function responseHeaders(response: ProbeResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return headers;
}

export function checkResponseStatus(response: ProbeResponse, requestedUrl: string): void {
  if (requestedUrl.startsWith("https:") && response.url?.startsWith("http:")) {
    throw new InsecureMediaRedirect("The HTTPS file link redirected to HTTP");
  }
  if (response.status >= 200 && response.status < 300) return;
  const header = responseHeaders(response)["retry-after"];
  const retryAfter = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : NaN;
  throw new RangeRecoveryError(`HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500,
    response.status, Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : undefined);
}

/** Retry the whole operation, including body reads, not just response headers. */
export async function recoverRequest<T>(
  operation: (signal: AbortSignal, receivedBytes: () => void) => Promise<T>,
  signal: AbortSignal,
  attempts = 3,
  onRetry?: RetryProgress,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const receivedBytes = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException("Media request timed out", "TimeoutError")), 45_000);
    };
    receivedBytes();
    let delayMs = Math.min(attempt * 150, 1_000);
    let httpStatus: number | undefined;
    try {
      return await operation(controller.signal, receivedBytes);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RangeRecoveryError && !error.retryable) throw error;
      if (error instanceof BrowserFetchError && isCertificateError(error.diagnostic.code)) throw error;
      // TypeError is fetch's network failure; body/timeout failures may also
      // be DOMExceptions. Do not retry application errors or validation bugs.
      const retryable = error instanceof RangeRecoveryError || error instanceof TypeError
        || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
      if (!retryable || attempt === attempts) throw error;
      if (error instanceof RangeRecoveryError && error.status) {
        httpStatus = error.status;
        // Honor a busy server's wait. If it exceeds our automatic retry window,
        // end the attempt instead of making an early request.
        if ((error.retryAfterMs ?? 0) > 30_000) throw error;
        delayMs = Math.max(error.retryAfterMs ?? 0, Math.min(1000 * 2 ** (attempt - 1), 8_000));
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    onRetry?.({ attempt: attempt + 1, maxAttempts: attempts, delayMs, ...(httpStatus ? {httpStatus} : {}) });
    await delay(delayMs, signal);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

/** Prefix reads stop at the limit even when a server ignores Range. */
export async function readBytes(response: ProbeResponse, limit: number, exact: boolean, onBytes?: (bytes: number) => void): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (!response.body) {
    // Only for body-less adapters/test doubles. Browser fetch streams bodies.
    bytes = new Uint8Array(await response.clone().arrayBuffer());
    if (!exact) return bytes.slice(0, limit);
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (exact && total + value.byteLength > limit) throw new RangeRecoveryError("Range response exceeds requested length");
        const chunk = value.subarray(0, limit - total);
        chunks.push(chunk);
        total += chunk.byteLength;
        onBytes?.(total);
        if (!exact && total === limit) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
      reader.releaseLock();
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  }
  if (exact && bytes.length !== limit) throw new RangeRecoveryError("Range response ended early", bytes.length < limit);
  return bytes;
}

function validateRange(headers: Record<string, string>, start: number, end: number, total: number): void {
  const range = parseContentRange(headers["content-range"]);
  if (!range || range.start !== start || range.end !== end || range.total !== total) {
    throw new RangeRecoveryError("Server returned a different byte range or file size");
  }
  if (headers["content-encoding"] && headers["content-encoding"] !== "identity") {
    throw new RangeRecoveryError("Encoded byte ranges cannot be reassembled");
  }
  const length = headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== end - start + 1)) {
    throw new RangeRecoveryError("Range Content-Length does not match requested bytes");
  }
}

/** An origin can serve a complete file while declining byte-range requests. */
export async function requestMedia<T extends ProbeResponse>(
  fetchFn: (url: string, init: ProbeInit) => Promise<T>, url: string, signal: AbortSignal,
): Promise<T> {
  const init = { credentials: "include", cache: "no-store", signal } as const;
  const response = await fetchFn(url, { ...init, headers: { range: "bytes=0-4095" } });
  if (response.status !== 400 && response.status !== 416 && response.status !== 501) return response;
  try { await response.body?.cancel(); } catch { /* The server may already have closed it. */ }
  signal.throwIfAborted();
  return fetchFn(url, init);
}

export async function readMediaProbe(response: ProbeResponse, url: string) {
  checkResponseStatus(response, url);
  const headers = responseHeaders(response);
  if (response.status === 206) {
    const range = parseContentRange(headers["content-range"]);
    if (!range) throw new RangeRecoveryError("Invalid probe Content-Range");
    const end = Math.min(4095, range.total - 1);
    validateRange(headers, 0, end, range.total);
    return { url: response.url || url, headers, bytes: await readBytes(response, end + 1, true) };
  }
  if (response.status !== 200) throw new RangeRecoveryError("No media body in probe response");
  delete headers["content-range"];
  return { url: response.url || url, headers, bytes: await readBytes(response, 4096, false) };
}

export async function probeMedia(
  fetchFn: ProbeFetch,
  url: string,
  signal: AbortSignal = new AbortController().signal,
  onRetry?: RetryProgress,
) {
  return recoverRequest(async attemptSignal => {
    const response = await requestMedia(fetchFn, url, attemptSignal);
    try { return await readMediaProbe(response, url); }
    finally {
      try { await response.body?.cancel(); } catch { /* Already consumed or interrupted. */ }
    }
  }, signal, 3, onRetry);
}

export async function fetchMediaRange(
  url: string, start: number, end: number, metadata: RangeMetadata, signal: AbortSignal,
  onRetry?: RetryProgress, fetchFile: MediaFetch = fetch, onBytes?: (bytes: number) => void,
): Promise<Uint8Array> {
  return recoverRequest(async (attemptSignal, receivedBytes) => {
    const response = await fetchFile(url, {
      credentials: "include", cache: "no-store", signal: attemptSignal,
      headers: { range: `bytes=${start}-${end}`, "if-range": metadata.validator },
    });
    try {
      checkResponseStatus(response, url);
      if (response.status !== 206) throw new RangeRecoveryError("Server ignored Range or the file changed");
      const headers = responseHeaders(response);
      validateRange(headers, start, end, metadata.total);
      const validator = headers[metadata.validatorHeader];
      if (validator !== undefined && validator !== metadata.validator) throw new RangeRecoveryError("File validator changed during download");
      return await readBytes(response, end - start + 1, true, bytes => {
        receivedBytes();
        onBytes?.(bytes);
      });
    } finally {
      try { await response.body?.cancel(); } catch { /* already consumed */ }
    }
  }, signal, 12, onRetry);
}
