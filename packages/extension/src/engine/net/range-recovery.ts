// Adapted from video-rescue/internal/rescue/downloader.go (MIT, ANcpLua).
// See licenses/video-rescue-MIT.txt. Browser adaptation: bounded probes,
// per-range retries and representation checks; no filesystem/native host.
import { isJobError, isRetryableStatus, MAX_AUTOMATIC_WAIT_MS, retryAfterMs, type JobError } from "@savemedia/core";
import { networkJobError, type NetworkPhase } from "./error-classification";
import { delay } from "./retry-delay";
import { MAX_RESUME_BYTES } from "./range-checkpoint";
import { isInterruptedRead, isTransferError, TransferError, transportFailure } from "./transfer-error";
import { diagnosticHost, httpReadFailure, reportHttpBody } from "../../util/http-diagnostics";


const EMPTY_RANGE_RETRY_BYTES = 64 * 1024;
/** A request that delivers no byte for this long is retried as a stalled connection. */
const STALL_TIMEOUT_MS = 45_000;

export interface RangeRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly httpStatus: number | null;
}
export type RetryProgress = (retry: RangeRetry) => void;

/** Reads an HTTP 200 returned to a range request in place: the whole file is already on the wire. */
export type WholeRangeReader<W> = (response: Response, signal: AbortSignal, receivedBytes: () => void) => Promise<W>;

/** A range read that ended with the whole file, received in place. */
export interface WholeResponse<W> { readonly whole: W }

export interface ProbeResponse {
  readonly status: number;
  readonly url?: string;
  readonly headers: { forEach(cb: (value: string, key: string) => void): void };
  readonly body?: ReadableStream<Uint8Array> | null;
  clone(): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface ProbeInit {
  readonly credentials: "include";
  readonly cache?: "no-store" | "default";
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

export type RangeMetadata = {
  readonly total: number;
  readonly validator: string;
} & (
  | { readonly validatorHeader: "etag" | "last-modified"; readonly digest?: string }
  | { readonly validatorHeader: "repr-digest"; readonly digest: string }
);

export interface ExpectedRangeFile {
  readonly total: number;
  readonly metadata: RangeMetadata | null;
}

function isHttpDowngrade(requestedUrl: string, finalUrl: string | undefined): boolean {
  return requestedUrl.startsWith("https:") && finalUrl?.startsWith("http:") === true;
}

function mediaOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

/**
 * The one mapping from a transfer failure to the JobError the user sees.
 * Addresses leave the engine as an origin or host, never as a signed URL.
 */
export function rangeFailure(error: unknown, url: string, phase: NetworkPhase): JobError {
  if (isJobError(error)) return error;
  if (!(error instanceof TransferError)) {
    return { code: "engine_job_failed", severity: "terminal", at: phase, cause: "unexpected", detail: error instanceof Error ? error.name : "unknown" };
  }
  const { facts } = error;
  const address = facts.url || url;
  const host = diagnosticHost(address);
  const bytes = { receivedBytes: facts.received ?? null, totalBytes: facts.expected ?? facts.range?.total ?? null };
  const failed = (reason: Extract<JobError, { code: "transfer_failed" }>["reason"], httpStatus = facts.status ?? null): JobError =>
    ({ code: "transfer_failed", severity: "terminal", reason, host, ...bytes, httpStatus });
  switch (error.reason) {
    case "http-status":
    case "network":
    case "timeout":
      return networkJobError(error, phase, mediaOrigin(address) || mediaOrigin(url));
    case "insecure-redirect":
      return { code: "insecure_media_redirect", severity: "terminal" };
    case "range-empty":
      return { code: "range_body_empty", severity: "terminal", host, rangeStart: facts.range?.start ?? 0, rangeEnd: facts.range?.end ?? 0,
        totalBytes: facts.range?.total ?? 0, declaredBytes: facts.declaredLength ?? null, reconnects: facts.reconnects ?? 0,
        reason: facts.emptyBody ?? "read-error" };
    case "checksum":
      return { code: "verification_checksum", severity: "terminal", algo: "sha256",
        expected: facts.digest?.expected ?? "", got: facts.digest?.actual ?? "" };
    case "body-short": return failed("ended-early");
    case "range-ignored": return failed("resume-refused", facts.status ?? 200);
    case "range-refused": return failed("resume-refused");
    case "no-validator": return failed("resume-unverifiable");
    case "changed": return failed("file-changed");
    case "content-mismatch": return failed("content-mismatch");
    case "redirected": return failed("link-changed");
    case "range-mismatch": return failed("range-mismatch");
    case "range-length": return failed("range-length");
    case "range-slices": return failed("range-slices");
    case "range-encoded": return failed("range-encoded");
    case "body-long": return failed("body-long");
  }
}

export function parseContentRange(value: string | undefined): ContentRange | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number) as [number, number, number];
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

/** HTTP can combine identical Content-Length fields into a comma-separated value. */
function parseContentLength(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const values = value.split(",").map(part => part.trim());
  const length = Number(values[0]);
  return Number.isSafeInteger(length) && values.every(part => /^\d+$/.test(part) && Number(part) === length) ? length : null;
}

export function rangeMetadata(headers: Readonly<Record<string, string>>): RangeMetadata | null {
  const range = parseContentRange(headers["content-range"]);
  if (!range || range.start !== 0 || range.end > 4095) return null;
  return representationMetadata(headers, range.total);
}

export function identityEncoded(headers: Readonly<Record<string, string>>): boolean {
  const encoding = headers["content-encoding"];
  return !encoding || encoding.trim().toLowerCase() === "identity";
}

// Repr-Digest covers the entire file even on a 206. Content-Digest on a
// range only covers that range. The file is hashed a window at a time
// (partial-file), so the limit bounds the time the check takes, not memory:
// it is the size up to which bytes are kept for a retry at all.
function representationDigest(headers: Readonly<Record<string, string>>, total: number): string | undefined {
  if (total > MAX_RESUME_BYTES) return undefined;
  return /(?:^|,)\s*sha-256=:([A-Za-z0-9+/]{43}=):\s*(?:,|$)/.exec(headers["repr-digest"] ?? "")?.[1];
}

export function representationMetadata(headers: Readonly<Record<string, string>>, total: number): RangeMetadata | null {
  if (!identityEncoded(headers)) return null;
  const etag = headers.etag?.trim();
  if (etag && /^"[^"\r\n]*"$/.test(etag)) return { total, validator: etag, validatorHeader: "etag" };
  const modified = headers["last-modified"]?.trim();
  if (modified && Number.isFinite(Date.parse(modified))) {
    return { total, validator: modified, validatorHeader: "last-modified" };
  }
  return null;
}

export function resumeMetadata(headers: Readonly<Record<string, string>>, total: number): RangeMetadata | null {
  if (!identityEncoded(headers)) return null;
  const version = representationMetadata(headers, total);
  const digest = representationDigest(headers, total);
  if (!digest) return version;
  return version ? {...version, digest} : {total, validator: digest, validatorHeader: "repr-digest", digest};
}

export function responseHeaders(response: ProbeResponse): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return headers;
}

export function checkResponseStatus(response: ProbeResponse, requestedUrl: string): void {
  if (response.status >= 200 && response.status < 300) {
    if (isHttpDowngrade(requestedUrl, response.url)) throw new TransferError("insecure-redirect", { url: requestedUrl });
    return;
  }
  throw new TransferError("http-status", { url: response.url || requestedUrl, status: response.status,
    retryAfterMs: retryAfterMs(responseHeaders(response)["retry-after"]) }, isRetryableStatus("segment", response.status));
}

const RANGE_REFUSALS = new Set([400, 416, 501]);

/**
 * The status check for a request that names a byte range. HTTP 400, 416 or
 * 501 is the server refusing byte ranges of this file: range-refused,
 * wherever in the save the range was asked for.
 */
export function checkRangeStatus(response: ProbeResponse, requestedUrl: string, received: number, expected: number | null): void {
  if (RANGE_REFUSALS.has(response.status)) {
    throw new TransferError("range-refused", { url: response.url || requestedUrl, status: response.status, received, expected });
  }
  checkResponseStatus(response, requestedUrl);
}

/** The If-Range header a validator allows. A whole-file checksum is no HTTP validator. */
export function ifRangeHeader(metadata: RangeMetadata | null | undefined): Record<string, string> {
  return metadata && metadata.validatorHeader !== "repr-digest" ? { "if-range": metadata.validator } : {};
}

export type EmptyBody = "declared-empty" | "stream-ended" | "read-error" | "timeout";

/** Why a granted range supplied no byte: a stall, a declared empty body, a clean end, or a read error. */
export function emptyBodyReason(attemptSignal: AbortSignal, error: unknown, declaredEmpty: boolean): EmptyBody {
  if (attemptSignal.reason?.name === "TimeoutError" || isTransferError(error, "timeout")) return "timeout";
  if (declaredEmpty) return "declared-empty";
  return isTransferError(error, "body-short") ? "stream-ended" : "read-error";
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
      timer = setTimeout(() => controller.abort(new DOMException("Media request timed out", "TimeoutError")), STALL_TIMEOUT_MS);
    };
    receivedBytes();
    let delayMs = Math.min(attempt * 150, 1_000);
    let httpStatus: number | null = null;
    try {
      return await operation(controller.signal, receivedBytes);
    } catch (error) {
      signal.throwIfAborted();
      // A stalled request surfaces as the attempt signal's timeout reason.
      const failure = controller.signal.aborted && !isTransferError(error)
        ? transportFailure(controller.signal.reason, "", "body") : error;
      if (!isInterruptedRead(failure) || attempt === attempts) throw failure;
      if (failure.facts.status) {
        httpStatus = failure.facts.status;
        // Honor a busy server's wait. If it exceeds our automatic retry window,
        // end the attempt instead of making an early request.
        const wait = failure.facts.retryAfterMs ?? 0;
        if (wait > MAX_AUTOMATIC_WAIT_MS) throw failure;
        delayMs = Math.max(wait, Math.min(1000 * 2 ** (attempt - 1), 8_000));
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
    onRetry?.({ attempt: attempt + 1, maxAttempts: attempts, delayMs, httpStatus });
    await delay(delayMs, signal);
  }
}

async function consumeBytes(response: ProbeResponse, url: string, limit: number, exact: boolean,
  accept: (chunk: Uint8Array) => void): Promise<number> {
  let total = 0;
  function brokenRead(error: unknown): unknown {
    reportHttpBody(response, total, httpReadFailure(error));
    return transportFailure(error, response.url || url, "body", total, limit);
  }
  function append(value: Uint8Array): void {
    if (exact && total + value.byteLength > limit) {
      throw new TransferError("body-long", { url: response.url || url, received: total + value.byteLength, expected: limit });
    }
    const chunk = value.subarray(0, limit - total);
    if (!chunk.byteLength) return;
    total += chunk.byteLength;
    accept(chunk);
  }
  if (!response.body) {
    let bytes: ArrayBuffer;
    try { bytes = await response.clone().arrayBuffer(); }
    catch (error) { throw brokenRead(error); }
    append(new Uint8Array(bytes));
  } else {
    const reader = response.body.getReader();
    try {
      while (true) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await reader.read(); }
        catch (error) { throw brokenRead(error); }
        const { done, value } = next;
        if (done) break;
        append(value);
        if (!exact && total === limit) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
      reader.releaseLock();
    }
  }
  if (exact && total !== limit) {
    reportHttpBody(response, total, "ended-early");
    throw new TransferError("body-short", { url: response.url || url, received: total, expected: limit });
  }
  reportHttpBody(response, total, !exact && total === limit ? "prefix-read" : "complete");
  return total;
}

/** Prefix reads stop at the limit even when a server ignores Range. */
export async function readBytes(response: ProbeResponse, url: string, limit: number, exact: boolean): Promise<Uint8Array> {
  const buffer = new Uint8Array(limit);
  let offset = 0;
  await consumeBytes(response, url, limit, exact, chunk => { buffer.set(chunk, offset); offset += chunk.length; });
  return buffer.subarray(0, offset);
}

/** Whether a response's validator and checksum still name the version `metadata` describes. Absent headers prove nothing. */
export function sameVersion(headers: Readonly<Record<string, string>>, metadata: RangeMetadata | null | undefined): boolean {
  if (!metadata) return true;
  if (metadata.digest) {
    const digest = representationDigest(headers, metadata.total);
    if (digest && metadata.digest !== digest) return false;
  }
  if (metadata.validatorHeader === "repr-digest") return true;
  const validator = headers[metadata.validatorHeader];
  return validator === undefined || validator === metadata.validator;
}

function checkValidator(headers: Readonly<Record<string, string>>, metadata: RangeMetadata | null, url: string): void {
  if (!sameVersion(headers, metadata)) throw new TransferError("changed", { url });
}

export function validateRange(headers: Record<string, string>, url: string, start: number, end: number, total: number,
  metadata?: RangeMetadata): ContentRange {
  const range = parseContentRange(headers["content-range"]);
  const requested = { start, end, total };
  if (range && range.total !== total) throw new TransferError("changed", { url, range: requested });
  if (!range || range.start !== start || range.end > end) throw new TransferError("range-mismatch", { url, range: requested });
  if (!identityEncoded(headers)) throw new TransferError("range-encoded", { url, range: requested });
  checkValidator(headers, metadata ?? null, url);
  const length = parseContentLength(headers["content-length"]);
  if (headers["content-length"] !== undefined && length !== range.end - range.start + 1) {
    throw new TransferError("range-length", { url, range: { start: range.start, end: range.end, total }, declaredLength: length,
      expected: total, metadata: metadata ?? representationMetadata(headers, total) });
  }
  return range;
}

/**
 * The length a complete-file response states for itself: its Content-Length,
 * or a Content-Range that covers the whole file. A range of part of the file,
 * or lengths that contradict each other, cannot be placed.
 */
export function statedLength(status: number, headers: Readonly<Record<string, string>>, url: string): number | null {
  // Fetch exposes decoded bytes. A compressed response's Content-Length counts wire bytes.
  const declared = identityEncoded(headers) ? parseContentLength(headers["content-length"]) : null;
  const header = headers["content-range"];
  if (header === undefined) {
    if (status !== 200) throw new TransferError("range-mismatch", { url, status });
    return declared;
  }
  const range = parseContentRange(header);
  if (!range || range.start !== 0 || range.end + 1 !== range.total) throw new TransferError("range-mismatch", { url, status });
  if (!identityEncoded(headers)) throw new TransferError("range-encoded", { url, status });
  if (headers["content-length"] !== undefined && declared !== range.total) {
    throw new TransferError("range-length", { url, status, declaredLength: declared, expected: range.total });
  }
  return range.total;
}

/** Establish the expected size before consuming a standalone file response. */
export function wholeResponseLength(status: number, headers: Record<string, string>, url: string,
  afterRange?: ExpectedRangeFile): number | null {
  if (afterRange && (status === 206 || (status === 200 && headers["content-range"] !== undefined))) {
    const range = validateRange(headers, url, 0, afterRange.total - 1, afterRange.total, afterRange.metadata ?? undefined);
    if (range.end + 1 !== afterRange.total) throw new TransferError("range-mismatch", { url, range });
    return range.total;
  }
  if (status !== 200 || headers["content-range"] !== undefined) throw new TransferError("range-mismatch", { url });
  // Fetch exposes decoded bytes. A compressed response's Content-Length counts wire bytes.
  const encoded = !identityEncoded(headers);
  const declared = encoded ? null : parseContentLength(headers["content-length"]);
  if (!afterRange) return declared;
  checkValidator(headers, afterRange.metadata, url);
  if (!encoded && headers["content-length"] !== undefined && declared !== afterRange.total) {
    throw new TransferError("changed", { url, expected: afterRange.total });
  }
  return afterRange.total;
}

/** An origin can serve a complete file while declining byte-range requests. */
export async function requestMedia<T extends ProbeResponse>(
  fetchFn: (url: string, init: ProbeInit) => Promise<T>, url: string, signal: AbortSignal,
): Promise<T> {
  const init = { credentials: "include", cache: "no-store", signal } as const;
  const response = await fetchFn(url, { ...init, headers: { range: "bytes=0-4095" } }).catch(error => {
    throw transportFailure(error, url, "request");
  });
  if (!RANGE_REFUSALS.has(response.status)) return response;
  try { await response.body?.cancel(); } catch { /* The server may already have closed it. */ }
  signal.throwIfAborted();
  return fetchFn(url, init).catch(error => { throw transportFailure(error, url, "request"); });
}

export interface MediaProbe {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bytes: Uint8Array;
}

export async function readMediaProbe(response: ProbeResponse, url: string, afterRange?: ExpectedRangeFile): Promise<MediaProbe> {
  checkResponseStatus(response, url);
  const headers = responseHeaders(response);
  const address = response.url || url;
  if (afterRange) {
    wholeResponseLength(response.status, headers, address, afterRange);
  } else if (response.status === 206) {
    const range = parseContentRange(headers["content-range"]);
    if (!range) throw new TransferError("range-mismatch", { url: address });
    const end = Math.min(4095, range.total - 1);
    validateRange(headers, address, 0, end, range.total);
    if (range.end < end) {
      throw new TransferError("range-length", { url: address, range, expected: range.total, metadata: rangeMetadata(headers) });
    }
    return { url: address, headers, bytes: await readBytes(response, url, end + 1, true) };
  } else if (response.status !== 200) throw new TransferError("range-mismatch", { url: address, status: response.status });
  delete headers["content-range"];
  return { url: address, headers, bytes: await readBytes(response, url, 4096, false) };
}

/** A contradictory range still identified the file: the whole-file request must match it. */
export function rangeFile(error: TransferError): ExpectedRangeFile | null {
  const total = error.facts.expected ?? error.facts.range?.total;
  return error.reason === "range-length" && typeof total === "number" ? { total, metadata: error.facts.metadata ?? null } : null;
}

export async function probeMedia(
  fetchFn: ProbeFetch,
  url: string,
  signal: AbortSignal = new AbortController().signal,
  onRetry?: RetryProgress,
): Promise<MediaProbe> {
  const read = (afterRange?: ExpectedRangeFile) => recoverRequest(async attemptSignal => {
    const response = afterRange
      ? await fetchFn(url, { credentials: "include", cache: "no-store", signal: attemptSignal }).catch(error => {
        throw transportFailure(error, url, "request");
      })
      : await requestMedia(fetchFn, url, attemptSignal);
    try { return await readMediaProbe(response, url, afterRange); }
    finally {
      try { await response.body?.cancel(); } catch { /* Already consumed or interrupted. */ }
    }
  }, signal, 3, onRetry);
  try { return await read(); }
  catch (error) {
    const expected = isTransferError(error, "range-length") ? rangeFile(error) : null;
    if (!expected) throw error;
    return read(expected);
  }
}

export interface RangeReadOptions<W> {
  readonly signal: AbortSignal;
  readonly fetchFile?: MediaFetch | undefined;
  readonly onRetry?: RetryProgress | undefined;
  readonly onBytes?: ((bytes: number) => void) | undefined;
  /** Receives the verified bytes of a part that failed before it was complete. */
  readonly keepPartial?: ((prefix: Blob) => void) | undefined;
  readonly onWholeResponse?: WholeRangeReader<W> | undefined;
}

/**
 * One validated byte range. A server that caps ranges is followed in shorter
 * requests; an empty HTTP 206 is confirmed once with a short range at the same
 * offset; a contradictory length is retried once. An HTTP 200 is read in place
 * by `onWholeResponse` when given, else it ends the range read as range-ignored.
 */
export async function fetchMediaRange<W = never>(
  url: string, start: number, end: number, metadata: RangeMetadata, options: RangeReadOptions<W>,
): Promise<Uint8Array | WholeResponse<W>> {
  const { signal, onRetry, onBytes, keepPartial, onWholeResponse } = options;
  const fetchFile = options.fetchFile ?? fetch;
  const buffer = new Uint8Array(end - start + 1);
  let filled = 0;
  let maxSpan = buffer.length;
  let emptyOffset: number | undefined;
  let lastLengthRetryOffset: number | undefined;
  let whole: WholeResponse<W> | undefined;
  // Bound requests when a server caps a large part to very small slices.
  let shorterResponses = 0;
  function requestEnd(offset: number): number {
    const span = emptyOffset === offset ? Math.min(maxSpan, EMPTY_RANGE_RETRY_BYTES) : maxSpan;
    return Math.min(end, offset + span - 1);
  }
  const read = async (attemptSignal: AbortSignal, receivedBytes: () => void) => {
    attemptSignal.throwIfAborted();
    const offset = start + filled;
    const last = requestEnd(offset);
    let servedEnd = last;
    let response: Response;
    try {
      response = await fetchFile(url, {
        credentials: "include", cache: "no-store", signal: attemptSignal,
        headers: { range: `bytes=${offset}-${last}`, ...ifRangeHeader(metadata) },
      });
    } catch (error) {
      throw transportFailure(error, url, "request", start + filled, metadata.total);
    }
    let readingBody = false;
    try {
      checkRangeStatus(response, url, offset, metadata.total);
      if (response.status === 200) {
        if (onWholeResponse) {
          whole = { whole: await onWholeResponse(response, attemptSignal, receivedBytes) };
          return;
        }
        throw new TransferError("range-ignored", { url: response.url || url, status: 200, received: offset, expected: metadata.total });
      }
      if (response.status !== 206) throw new TransferError("range-mismatch", { url: response.url || url, status: response.status });
      const headers = responseHeaders(response);
      const range = validateRange(headers, response.url || url, offset, last, metadata.total, metadata);
      servedEnd = range.end;
      const span = range.end - range.start + 1;
      if (range.end < last) maxSpan = span;
      readingBody = true;
      await consumeBytes(response, url, span, true, chunk => {
        buffer.set(chunk, filled);
        filled += chunk.byteLength;
        emptyOffset = undefined;
        receivedBytes();
        onBytes?.(filled);
      });
    } catch (caught) {
      const error = caught instanceof TransferError ? caught.with({ received: start + filled, expected: metadata.total }) : caught;
      const brokenRead = readingBody && isInterruptedRead(error) && !signal.aborted;
      // A checked range with Content-Length zero cannot supply a byte either.
      // Confirm both forms at the same offset before ending the part attempt.
      const declaredEmpty = isTransferError(error, "range-length") && error.facts.declaredLength === 0;
      if (declaredEmpty || (brokenRead && start + filled === offset)) {
        if (!readingBody) reportHttpBody(response, 0, "range-rejected");
        const repeated = emptyOffset === offset;
        emptyOffset = offset;
        throw new TransferError("range-empty", { url: response.url || url, range: { start: offset, end: last, total: metadata.total },
          declaredLength: parseContentLength(response.headers.get("content-length")), received: start + filled, expected: metadata.total,
          emptyBody: emptyBodyReason(attemptSignal, error, declaredEmpty),
        }, !repeated);
      }
      if (isTransferError(error, "range-length")) {
        const length = error.facts.declaredLength ?? null;
        if (length !== null && length > 0 && length < last - offset + 1) {
          maxSpan = length;
          return;
        }
        // Discard the contradictory response. Retry the same conditional range
        // once before the job reports it.
        if (lastLengthRetryOffset !== offset) {
          lastLengthRetryOffset = offset;
          throw error.with({}, true);
        }
        throw error.with({}, false);
      }
      // A stream can fail after its last data event. Recheck the last byte
      // under the same validator before advancing.
      if (filled === servedEnd - start + 1 && isInterruptedRead(error)) filled--;
      throw error;
    } finally {
      try { await response.body?.cancel(); } catch { /* already consumed */ }
    }
  };
  try {
    await recoverRequest(async (attemptSignal, receivedBytes) => {
      while (filled < buffer.length && !whole) {
        await read(attemptSignal, receivedBytes);
        if (!whole && filled < buffer.length && ++shorterResponses + Math.ceil((buffer.length - filled) / maxSpan) > 64) {
          throw new TransferError("range-slices", { url, received: start + filled, expected: metadata.total });
        }
      }
    }, signal, 12, onRetry);
    return whole ?? buffer;
  } catch (error) {
    if (filled && isTransferError(error)) keepPartial?.(new Blob([buffer.subarray(0, filled)]));
    throw error;
  }
}
