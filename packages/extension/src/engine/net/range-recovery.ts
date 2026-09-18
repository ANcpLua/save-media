// Adapted from video-rescue/internal/rescue/downloader.go (MIT, ANcpLua).
// See licenses/video-rescue-MIT.txt. Browser adaptation: bounded probes,
// per-range retries and representation checks; no filesystem/native host.
import { BROWSER_OUTPUT_LIMIT_BYTES } from "@savemedia/core";

export interface ProbeResponse {
  readonly status: number;
  readonly headers: { forEach(cb: (value: string, key: string) => void): void };
  readonly body?: ReadableStream<Uint8Array> | null;
  clone(): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface ProbeInit {
  readonly credentials: "include";
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

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
  constructor(message: string, readonly retryable = false, readonly status?: number) {
    super(message);
    this.name = "RangeRecoveryError";
  }
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

export function canRecoverWithRanges(url: string, headers: Readonly<Record<string, string>>): boolean {
  const metadata = rangeMetadata(headers);
  return url.startsWith("https://") && metadata !== null && metadata.total < BROWSER_OUTPUT_LIMIT_BYTES;
}

export function responseHeaders(response: ProbeResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return headers;
}

export function checkResponseStatus(response: ProbeResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  throw new RangeRecoveryError(`HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500, response.status);
}

/** Retry the whole operation, including body reads, not just response headers. */
export async function recoverRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Range request timed out", "TimeoutError")), 45_000);
    try {
      return await operation(controller.signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof RangeRecoveryError && !error.retryable) throw error;
      // TypeError is fetch's network failure; body/timeout failures may also
      // be DOMExceptions. Do not retry application errors or validation bugs.
      const retryable = error instanceof RangeRecoveryError || error instanceof TypeError
        || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
      if (!retryable || attempt === attempts) throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    await delay(Math.min(attempt * 150, 1_000), signal);
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
export async function readBytes(response: ProbeResponse, limit: number, exact: boolean): Promise<Uint8Array> {
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

export async function probeMedia(
  fetchFn: ProbeFetch,
  url: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ headers: Record<string, string>; bytes: Uint8Array }> {
  return recoverRequest(async attemptSignal => {
    const response = await fetchFn(url, { credentials: "include", headers: { range: "bytes=0-4095" }, signal: attemptSignal });
    try {
      checkResponseStatus(response);
      const headers = responseHeaders(response);
      if (response.status === 206) {
        const range = parseContentRange(headers["content-range"]);
        if (!range) throw new RangeRecoveryError("Invalid probe Content-Range");
        const end = Math.min(4095, range.total - 1);
        validateRange(headers, 0, end, range.total);
        return { headers, bytes: await readBytes(response, end + 1, true) };
      }
      if (response.status !== 200) throw new RangeRecoveryError("No media body in probe response");
      // Do not advertise recovery based on a stray Content-Range on a 200.
      delete headers["content-range"];
      return { headers, bytes: await readBytes(response, 4096, false) };
    } finally {
      try { await response.body?.cancel(); } catch { /* already consumed */ }
    }
  }, signal);
}

export async function fetchMediaRange(
  url: string, start: number, end: number, metadata: RangeMetadata, signal: AbortSignal,
): Promise<Uint8Array> {
  return recoverRequest(async attemptSignal => {
    const response = await fetch(url, {
      credentials: "include", signal: attemptSignal,
      headers: { range: `bytes=${start}-${end}`, "if-range": metadata.validator },
    });
    try {
      checkResponseStatus(response);
      if (response.status !== 206) throw new RangeRecoveryError("Server ignored Range or the file changed");
      const headers = responseHeaders(response);
      validateRange(headers, start, end, metadata.total);
      const validator = headers[metadata.validatorHeader];
      if (validator !== undefined && validator !== metadata.validator) throw new RangeRecoveryError("File validator changed during download");
      return await readBytes(response, end - start + 1, true);
    } finally {
      try { await response.body?.cancel(); } catch { /* already consumed */ }
    }
  }, signal, 12);
}
