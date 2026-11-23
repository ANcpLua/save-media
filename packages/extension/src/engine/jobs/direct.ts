import { isJobError, MAX_AUTOMATIC_WAIT_MS, type DirectPlan, type JobError, type OutputContainer } from "@savemedia/core";
import { originalMediaFilename } from "../../util/filename";
import { directResumeScope } from "../../types/transfer";
import type { JobResult, ProgressFn, RetainedPartial, TransferStage } from "../job";
import {
  checkRangeStatus, checkResponseStatus, emptyBodyReason, fetchMediaRange, identityEncoded, ifRangeHeader, parseContentRange,
  rangeFailure, rangeFile, rangeMetadata, readBytes, readMediaProbe, recoverRequest, requestMedia, resumeMetadata, responseHeaders,
  sameVersion, statedLength, validateRange,
  type EmptyBody, type ExpectedRangeFile, type MediaFetch, type RangeMetadata, type RetryProgress, type WholeRangeReader,
} from "../net/range-recovery";
import { isInterruptedRead, isOutage, isTransferError, retainedOutcome, TransferError, transportFailure } from "../net/transfer-error";
import { DIRECT_MEDIA_TYPES, identifyResponse, requireDirectVideo, validateDirectBlob } from "../verify-direct";
import { checkpointSize, checkpointTotal, clearCheckpoint, contiguousRangePrefix, getCheckpoint, keepCheckpoint,
  RANGE_CHUNK_BYTES as CHUNK_BYTES, resumeIdentity, type FileCheckpoint, type RangeResume } from "../net/range-checkpoint";
import { compareFilePrefix, verifyFileDigest } from "../net/partial-file";
import { delay } from "../net/retry-delay";
import { MAX_RECONNECTS, reconnectWaitMs } from "../net/reconnect";
import { BlobParts } from "../blob-parts";
import { httpReadFailure, reportHttpBody } from "../../util/http-diagnostics";

const WORKERS = 4;
const RECONNECT_PROGRESS_BYTES = 64 * 1024;

export interface DirectJobOptions {
  readonly onProgress: ProgressFn;
  readonly signal: AbortSignal;
  readonly tabId?: number | undefined;
  readonly fetchFile?: MediaFetch | undefined;
  readonly resumeKey?: string | undefined;
  /** A failed save that keeps its verified bytes for Retry save reports them here, before it throws. */
  readonly onRetained?: ((partial: RetainedPartial) => void) | undefined;
  /** Called after the job, when a later failed save took the engine's one slot and these kept bytes are gone. */
  readonly onRetainedReleased?: (() => void) | undefined;
}

/** A complete file. `resumed`: bytes kept from an earlier response are part of it. */
interface DirectFile {
  readonly blob: Blob;
  readonly container: OutputContainer;
  readonly resumed: boolean;
}

/** Identified media bytes from byte zero that a response delivered before it stopped. */
interface Cut {
  readonly prefix: Blob;
  readonly total: number;
  readonly metadata: RangeMetadata | null;
  /** The address that served the prefix. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expected: OutputContainer | undefined;
  readonly earlier: RangeMetadata | null;
}

/** A body that stopped after identified media bytes arrived: an outcome to continue from, not an error. */
interface InterruptedBody extends Cut {
  readonly kind: "interrupted";
  /** Why it stopped: a clean early end (body-short), a dropped connection (network) or a stall (timeout). */
  readonly cause: TransferError;
}

type BodyRead = { readonly kind: "file"; readonly file: DirectFile } | InterruptedBody;

/** One save: its address, transport, held bytes and progress. */
interface Transfer {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly fetchFile: MediaFetch;
  readonly resume: RangeResume;
  readonly report: (stage: TransferStage, bytes: number, total: number | null) => void;
  /**
   * Where this job read each checkpoint it recorded, and under which
   * validator. A reconnect within the job continues there without reading or
   * comparing those bytes again; only a later job has to establish them anew.
   */
  readonly sources: WeakMap<FileCheckpoint, { readonly url: string; readonly metadata: RangeMetadata }>;
  /** How often the job dropped what it held. Parts of an older generation are never held again. */
  dropped: number;
}

interface WholeFileOptions {
  /** The file as earlier responses described it: its length when this response states none, and its checksum. */
  readonly known?: ExpectedRangeFile | undefined;
  /** Bytes from byte zero this response may replace in place: an HTTP 200 to a range request. */
  readonly replaying?: Blob | undefined;
  /** The container the replaced bytes identified. */
  readonly expected?: OutputContainer | undefined;
}

/**
 * Saves one direct file and verifies it before it leaves the engine.
 *
 * The server's own answers decide each step, and the policy table in
 * transfer-error decides what each failure means for the bytes in hand. A
 * body that stops early after identified media bytes continues only through
 * a byte range the server grants under the same validator; a server that
 * refuses, cannot prove the file version, or stops early again ends the save
 * with a plain report. Only a network outage, where the server did not
 * answer, waits and reconnects. Bytes that turn out not to belong to the
 * current file are dropped and the file is read once more from byte zero.
 */
export async function runDirectJob(plan: DirectPlan, options: DirectJobOptions): Promise<JobResult> {
  const { signal, onProgress, tabId, resumeKey } = options;
  const scope = resumeKey ? directResumeScope(tabId, resumeKey) : await resumeIdentity("direct:" + tabId, plan.url, plan.filename);
  // The job holds its own checkpoint. The engine keeps one for Retry save only
  // after the job failed, so a running save never replaces another's kept bytes.
  const resume: RangeResume = {
    signal,
    previous: getCheckpoint(scope),
    interrupted(checkpoint) {
      const held = resume.previous;
      if (signal.aborted || (held && checkpointTotal(held) === checkpointTotal(checkpoint) && checkpointSize(held) > checkpointSize(checkpoint))) return;
      resume.previous = checkpoint;
    },
    discard() { resume.previous = undefined; clearCheckpoint(scope); },
  };
  const transfer: Transfer = {
    url: plan.url, signal, fetchFile: options.fetchFile ?? fetch, resume, sources: new WeakMap(), dropped: 0,
    report(stage, bytes, total) {
      const held = resume.previous;
      const retained = held && total === checkpointTotal(held) ? checkpointSize(held) : 0;
      onProgress({ stage, bytesWritten: Math.max(bytes, retained), bytesTotal: total });
    },
  };
  try {
    const { blob, filename } = await verifiedDirectFile(plan, transfer);
    resume.discard();
    return { blobUrl: URL.createObjectURL(blob), filename, checksum: "" };
  } catch (error) {
    if (signal.aborted) {
      resume.discard();
      throw error;
    }
    // Only bytes a later request can continue from are kept, and the failure
    // says how long Retry save can use them.
    const held = retainedOutcome(error) === "keep" ? resume.previous : undefined;
    const expiresAt = held ? keepCheckpoint(scope, held, options.onRetainedReleased) : null;
    if (held && expiresAt !== null) options.onRetained?.({ bytes: checkpointSize(held), total: checkpointTotal(held), expiresAt });
    else resume.discard();
    throw rangeFailure(error, plan.url, "direct");
  }
}

async function verifiedDirectFile(plan: DirectPlan, t: Transfer): Promise<{ blob: Blob; filename: string }> {
  for (let clean = false; ; clean = true) {
    let file: DirectFile | undefined;
    try {
      file = await readWithAutomaticResume(t);
      return await finishDirectFile(file, plan.filename, t);
    } catch (error) {
      t.signal.throwIfAborted();
      if (!clean && rejectsRetained(error, file)) {
        // The bytes in hand belong to another version of the file. One clean
        // read from byte zero; a second failure is the answer.
        drop(t);
        t.report({ kind: "restarting", cause: "retained-rejected" }, 0, null);
        continue;
      }
      throw error;
    }
  }
}

/** Another version of the file (changed, content mismatch, checksum), or a resumed file whose container fails its check. */
function rejectsRetained(error: unknown, file: DirectFile | undefined): boolean {
  return retainedOutcome(error) === "restart" || (file?.resumed === true && isJobError(error) && error.code === "verification_container");
}

/** Retry save cannot continue from the kept bytes: the server refuses, cannot prove the version, or stops early again. */
function cannotContinue(error: unknown): boolean {
  return isTransferError(error) && (retainedOutcome(error) === "drop" || error.reason === "body-short");
}

/** Drops the bytes the job holds. */
function drop(t: Transfer): void {
  t.resume.discard();
  t.dropped++;
}

/** Records bytes this job read from `url` as its checkpoint. With a validator, a reconnect within the job continues there. */
function hold(t: Transfer, checkpoint: FileCheckpoint, url: string, metadata: RangeMetadata | null): void {
  if (metadata) t.sources.set(checkpoint, { url, metadata });
  t.resume.interrupted(checkpoint);
}

async function readWithAutomaticResume(t: Transfer): Promise<DirectFile> {
  let reconnects = 0;
  let savedAtReset = 0;
  for (;;) {
    t.signal.throwIfAborted();
    try {
      return await readDirectFile(t, reconnects > 0);
    } catch (error) {
      t.signal.throwIfAborted();
      const held = t.resume.previous;
      const final = isTransferError(error) && reconnects ? error.with({ reconnects }) : error;
      // Only an outage waits and reconnects: no answer, a stalled connection, or a busy server that asked for a short wait.
      if (!held || !isOutage(error)) throw final;
      const retryAfter = error.facts.retryAfterMs ?? 0;
      if (retryAfter > MAX_AUTOMATIC_WAIT_MS) throw final;

      const bytes = checkpointSize(held);
      const total = checkpointTotal(held);
      // Count accumulated new bytes. Replaying the same prefix or moving a
      // few bytes around the same cutoff must not replenish the budget.
      const remaining = total - savedAtReset;
      const advance = Math.min(RECONNECT_PROGRESS_BYTES, Math.max(1, Math.ceil(remaining / MAX_RECONNECTS)));
      if (reconnects === 0 || bytes - savedAtReset >= advance) {
        savedAtReset = bytes;
        reconnects = 0;
      }
      if (reconnects >= MAX_RECONNECTS) throw final;
      const waitMs = reconnectWaitMs(reconnects, retryAfter);
      reconnects++;
      t.report({ kind: "reconnecting", waitMs }, bytes, total);
      await delay(waitMs, t.signal);
    }
  }
}

async function finishDirectFile(file: DirectFile, name: string, t: Transfer): Promise<{ blob: Blob; filename: string }> {
  let { blob } = file;
  t.report({ kind: "verifying" }, blob.size, blob.size);
  await validateDirectBlob(blob, file.container, t.signal);
  t.signal.throwIfAborted();
  t.report({ kind: "finalizing" }, blob.size, blob.size);
  const filename = originalMediaFilename(name, file.container) ?? name;
  // Chrome uses the blob MIME when choosing the final extension.
  if (file.container === "mp4" && /\.mov$/i.test(filename)) blob = blob.slice(0, blob.size, DIRECT_MEDIA_TYPES.mov);
  if (file.container === "mov" && /\.mp4$/i.test(filename)) blob = blob.slice(0, blob.size, DIRECT_MEDIA_TYPES.mp4);
  return { blob, filename };
}

function retrying(t: Transfer, bytes: () => number, total: number | null, part: { index: number; count: number } | null = null): RetryProgress {
  return retry => t.report({ kind: "retrying", attempt: retry.attempt, maxAttempts: retry.maxAttempts, waitMs: retry.delayMs,
    httpStatus: retry.httpStatus, part }, bytes(), total);
}

async function readDirectFile(t: Transfer, automatic: boolean): Promise<DirectFile> {
  if (t.resume.previous) {
    const recovered = await resumeFromCheckpoint(t, automatic);
    if (recovered) return recovered;
  }
  t.report({ kind: "probing" }, 0, null);
  const first = await probeDirectFile(t).catch(error => {
    // A discovery range that contradicts its own length still names the
    // file's length for one complete-file request.
    const contradictory = isTransferError(error, "range-length") ? rangeFile(error) : null;
    if (!contradictory) throw error;
    return { kind: "contradictory", known: contradictory } as const;
  });
  if (first.kind === "contradictory") return downloadWholeFile(t, { known: first.known });
  if (first.kind === "file") return first.file;
  if (first.kind === "interrupted") return finishInterruptedBody(t, first);
  const { probe, container, size } = first;
  const metadata = rangeMetadata(probe.headers);
  const known: ExpectedRangeFile = { total: size, metadata };
  // Without a validator, byte ranges could mix two versions of the file.
  if (!metadata) return downloadWholeFile(t, { known });
  try {
    const result = await downloadRanges(t, probe.url, metadata, { mime: DIRECT_MEDIA_TYPES[container] });
    return result.kind === "whole" ? result.file : { blob: result.blob, container, resumed: result.resumed };
  } catch (error) {
    t.signal.throwIfAborted();
    // Ranges the server cannot serve leave one complete-file request, unless
    // bytes are held: those continue after a reconnect instead.
    const contradictory = isTransferError(error, "range-length") ? rangeFile(error) : null;
    const unusable = isTransferError(error, "range-ignored", "range-refused")
      || (!t.resume.previous && isTransferError(error, "network", "timeout", "range-empty"));
    if (!contradictory && !unusable) throw error;
    t.report({ kind: "restarting", cause: "ranges-unusable" }, 0, size);
    return downloadWholeFile(t, { known: contradictory ?? known });
  }
}

/** The first request: a bounded discovery range, or the whole file when the server ignores Range. */
function probeDirectFile(t: Transfer) {
  return recoverRequest(async (attemptSignal, receivedBytes) => {
    const response = await requestMedia(t.fetchFile, t.url, attemptSignal);
    try {
      checkResponseStatus(response, t.url);
      // This response already contains the whole file. Reopening it can
      // consume a one-use URL or discard bytes from a slow connection.
      if (response.status === 200) return await readWholeFile(t, t.url, response, attemptSignal, receivedBytes, {});
      const probe = await readMediaProbe(response, t.url);
      const container = requireDirectVideo(probe.bytes, probe.headers);
      const size = parseContentRange(probe.headers["content-range"])!.total;
      if (size === probe.bytes.length) {
        const blob = new Blob([probe.bytes as BlobPart], { type: DIRECT_MEDIA_TYPES[container] });
        return { kind: "file", file: { blob, container, resumed: false } } as const;
      }
      return { kind: "probe", probe, container, size } as const;
    } finally {
      try { await response.body?.cancel(); } catch { /* Already consumed or interrupted. */ }
    }
  }, t.signal, 3, retrying(t, () => 0, null));
}

async function downloadWholeFile(t: Transfer, options: WholeFileOptions): Promise<DirectFile> {
  const read = await recoverRequest(async (attemptSignal, receivedBytes) => {
    let response: Response;
    try {
      response = await t.fetchFile(t.url, { credentials: "include", cache: "no-store", signal: attemptSignal });
    } catch (error) {
      throw transportFailure(error, t.url, "request");
    }
    try {
      checkResponseStatus(response, t.url);
      return await readWholeFile(t, t.url, response, attemptSignal, receivedBytes, options);
    } finally { await response.body?.cancel().catch(() => undefined); }
  }, t.signal, 3, retrying(t, () => 0, options.known?.total ?? null));
  return read.kind === "file" ? read.file : finishInterruptedBody(t, read);
}

/** Continue a body that stopped early, through byte ranges the server grants under the same validator. */
async function finishInterruptedBody(t: Transfer, cut: Cut, fetchFile = t.fetchFile): Promise<DirectFile> {
  t.report({ kind: "resuming" }, cut.prefix.size, cut.total);
  if (!cut.metadata) return recoverFilePrefix(t, cut.url, cut.prefix, cut.total, cut.expected, cut.earlier);
  const result = await downloadRanges(t, cut.url, cut.metadata, { prefix: cut.prefix, fetchFile,
    onWholeResponse: wholeRangeReader(t, cut.url, cut.prefix, cut.metadata, cut.expected) });
  return result.kind === "whole" ? result.file : identifyRecoveredFile(result.blob, cut.headers, cut.expected, cut.url);
}

async function identifyRecoveredFile(blob: Blob, headers: Readonly<Record<string, string>>, expected: OutputContainer | undefined,
  url: string): Promise<DirectFile> {
  const container = requireDirectVideo(new Uint8Array(await blob.slice(0, 4096).arrayBuffer()), { ...headers, "content-length": String(blob.size) });
  if (expected && expected !== container) throw new TransferError("content-mismatch", { url });
  return { blob: blob.slice(0, blob.size, DIRECT_MEDIA_TYPES[container]), container, resumed: true };
}

// An HTTP 200 returned to a range request is the whole file again. Read it in
// place: retrying the URL would discard a usable response, including one
// issued by a one-use link. If it stops early too, the save stops.
function wholeRangeReader(t: Transfer, url: string, prefix: Blob, metadata: RangeMetadata,
  expected: OutputContainer | undefined): WholeRangeReader<DirectFile> {
  return (response, attemptSignal, receivedBytes) => readReplacement(t, url, response, attemptSignal, receivedBytes,
    { expected, known: { total: metadata.total, metadata }, replaying: prefix });
}

async function readReplacement(t: Transfer, url: string, response: Response, signal: AbortSignal, receivedBytes: () => void,
  options: WholeFileOptions): Promise<DirectFile> {
  const read = await readWholeFile(t, url, response, signal, receivedBytes, options);
  if (read.kind === "file") return read.file;
  const held = t.resume.previous;
  const received = held && checkpointTotal(held) === read.total ? Math.max(checkpointSize(held), read.prefix.size) : read.prefix.size;
  // A dropped connection or a stall follows the outage policy: retry, then
  // reconnect from the bytes held. A clean early end is the server's answer.
  if (isTransferError(read.cause, "network", "timeout")) throw read.cause.with({ received });
  throw new TransferError("body-short", { url: read.url, received, expected: read.total, status: response.status }, false);
}

/**
 * Establish which file owns a prefix whose original response did not
 * identify its version: one byte at the first missing offset must come back
 * as a granted range with a validator, or the save stops.
 */
async function recoverFilePrefix(t: Transfer, url: string, prefix: Blob, reportedTotal: number,
  expected: OutputContainer | undefined, earlier: RangeMetadata | null): Promise<DirectFile> {
  const offset = prefix.size;
  const known: ExpectedRangeFile | undefined = reportedTotal > 0 ? { total: reportedTotal, metadata: earlier } : undefined;
  let emptyByteResponse = false;
  const emptyByte = (address: string, total: number, declaredLength: number | null, emptyBody: EmptyBody) => {
    const repeated = emptyByteResponse;
    emptyByteResponse = true;
    return new TransferError("range-empty", { url: address, range: { start: offset, end: offset, total }, declaredLength,
      received: offset, expected: total, emptyBody }, !repeated);
  };

  const current = await recoverRequest(async (attemptSignal, receivedBytes) => {
    let response: Response;
    try {
      response = await t.fetchFile(url, { credentials: "include", cache: "no-store", signal: attemptSignal,
        headers: { range: `bytes=${offset}-${offset}`, ...ifRangeHeader(earlier) },
      });
    } catch (error) {
      throw transportFailure(error, url, "request", offset, reportedTotal || null);
    }
    try {
      checkRangeStatus(response, url, offset, reportedTotal || null);
      const address = response.url || url;
      if (response.status === 200) {
        // A server that ignores the range has already opened the whole file.
        const file = await readReplacement(t, url, response, attemptSignal, receivedBytes, { expected, known, replaying: prefix });
        return { kind: "whole", file } as const;
      }
      const headers = responseHeaders(response);
      const range = parseContentRange(headers["content-range"]);
      if (response.status !== 206 || !range) {
        throw new TransferError("range-mismatch", { url, status: response.status, received: offset, expected: reportedTotal || null });
      }
      if (prefix.size >= range.total || (known && known.total !== range.total)) {
        throw new TransferError("changed", { url: address, received: offset, expected: range.total });
      }
      const observed = resumeMetadata(headers, range.total);
      const metadata = earlier && observed?.digest ? { ...earlier, digest: observed.digest } : earlier ?? observed;
      try { validateRange(headers, address, offset, offset, range.total, earlier ?? undefined); }
      catch (error) {
        if (isTransferError(error, "range-length") && error.facts.declaredLength === 0) {
          reportHttpBody(response, 0, "range-rejected");
          throw emptyByte(address, range.total, 0, "declared-empty");
        }
        throw error;
      }
      if (!metadata) throw new TransferError("no-validator", { url, status: 206, received: offset, expected: reportedTotal || null });
      let firstByte: Uint8Array;
      try {
        firstByte = await readBytes(response, url, 1, true);
      } catch (error) {
        if (isInterruptedRead(error) && !t.signal.aborted && !error.facts.received) {
          throw emptyByte(address, range.total, response.headers.get("content-length") === null ? null : 1,
            emptyBodyReason(attemptSignal, error, false));
        }
        throw error;
      }
      return { kind: "range", url: address, metadata, headers, seed: new Blob([prefix, firstByte as BlobPart]) } as const;
    } finally { await response.body?.cancel().catch(() => undefined); }
  }, t.signal, 3, retrying(t, () => prefix.size, reportedTotal || null));

  if (current.kind === "whole") return current.file;
  const { metadata } = current;
  const read = metadata.digest ? t.fetchFile : sameResourceFetch(t.fetchFile, await resumeIdentity("file", current.url, ""));
  const onWholeResponse = wholeRangeReader(t, current.url, prefix, metadata, expected);
  if (!metadata.digest) {
    t.report({ kind: "rechecking" }, prefix.size, metadata.total);
    const whole = await compareFilePrefix(prefix, metadata.total, current.url, t.signal, (start, end) =>
      fetchMediaRange(current.url, start, end - 1, metadata, { signal: t.signal, fetchFile: read, onWholeResponse }));
    if (whole) return whole;
  }
  // Carry the checksum into any checkpoint. It must still match the entire
  // assembled file before a current or later attempt can publish it.
  const result = await downloadRanges(t, current.url, metadata, { prefix: current.seed, fetchFile: read, onWholeResponse });
  return result.kind === "whole" ? result.file : identifyRecoveredFile(result.blob, current.headers, expected, current.url);
}

function sameResourceFetch(fetchFile: MediaFetch, resource: string): MediaFetch {
  return async (address, init) => {
    const response = await fetchFile(address, init);
    if (response.ok && response.url) {
      try {
        checkResponseStatus(response, address);
        if (await resumeIdentity("file", response.url, "") !== resource) throw new TransferError("redirected", { url: response.url });
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
    }
    return response;
  };
}

async function resumeFromCheckpoint(t: Transfer, automatic: boolean): Promise<DirectFile | undefined> {
  const previous = t.resume.previous!;
  const total = checkpointTotal(previous);
  const prefix = previous.kind === "prefix" ? previous.prefix : contiguousRangePrefix(previous.parts);
  const expected = previous.kind === "prefix" ? previous.container : undefined;
  t.report({ kind: "resuming" }, checkpointSize(previous), total);
  try {
    // This job read these bytes itself, from this address under this
    // validator: continue there without reading or comparing them again.
    const source = t.sources.get(previous);
    if (source) {
      const result = await downloadRanges(t, source.url, source.metadata, {
        parts: previous.kind === "ranges" ? previous.parts : undefined, prefix: previous.kind === "prefix" ? previous.prefix : undefined,
        onWholeResponse: wholeRangeReader(t, source.url, prefix, source.metadata, expected) });
      return result.kind === "whole" ? result.file : await identifyRecoveredFile(result.blob, {}, expected, source.url);
    }
    // Bytes an earlier job kept. Only a strong ETag on the same address
    // vouches for parts beyond the first gap.
    const address = await resumeIdentity("file", t.url, "");
    if (previous.kind === "ranges" && previous.metadata.validatorHeader === "etag"
      && previous.representation === await resumeIdentity(String(total), t.url, previous.metadata.validator)) {
      try {
        const result = await downloadRanges(t, t.url, previous.metadata, { parts: previous.parts,
          fetchFile: sameResourceFetch(t.fetchFile, address), onWholeResponse: wholeRangeReader(t, t.url, prefix, previous.metadata, undefined) });
        return result.kind === "whole" ? result.file : await identifyRecoveredFile(result.blob, {}, undefined, t.url);
      } catch (error) {
        t.signal.throwIfAborted();
        if (!isTransferError(error, "redirected")) throw error;
      }
    }
    if (!prefix.size) return undefined;
    if (previous.kind === "prefix" && previous.metadata && (previous.entry === address || previous.resource === address)) {
      try {
        return await finishInterruptedBody(t, { prefix, total, metadata: previous.metadata, url: t.url, headers: {}, expected, earlier: null },
          sameResourceFetch(t.fetchFile, previous.resource));
      } catch (error) {
        t.signal.throwIfAborted();
        if (!isTransferError(error, "redirected")) throw error;
      }
    }
    // A publisher may assign a new host to its named file. Only a whole-file
    // checksum carries over to that resource. Otherwise verify the saved bytes.
    const digest = previous.metadata?.digest;
    const checksum: RangeMetadata | null = digest ? { total, validatorHeader: "repr-digest", validator: digest, digest } : null;
    return await recoverFilePrefix(t, t.url, prefix, total, expected, checksum);
  } catch (error) {
    t.signal.throwIfAborted();
    // Retry save asked for the file again. Bytes the server will not let it
    // continue from are dropped and the file starts over from byte zero.
    if (!automatic && cannotContinue(error)) {
      drop(t);
      return undefined;
    }
    throw error;
  }
}

interface RangeOptions {
  readonly mime?: string | undefined;
  /** Verified bytes from byte zero that the ranges continue. */
  readonly prefix?: Blob | undefined;
  /** Parts of this version received earlier, sparse ones included. */
  readonly parts?: readonly (Blob | undefined)[] | undefined;
  readonly fetchFile?: MediaFetch | undefined;
  readonly onWholeResponse?: WholeRangeReader<DirectFile> | undefined;
}

type RangesResult =
  | { readonly kind: "ranges"; readonly blob: Blob; readonly resumed: boolean }
  | { readonly kind: "whole"; readonly file: DirectFile };

async function downloadRanges(t: Transfer, url: string, metadata: RangeMetadata, options: RangeOptions = {}): Promise<RangesResult> {
  const fetchFile = options.fetchFile ?? t.fetchFile;
  const count = Math.ceil(metadata.total / CHUNK_BYTES);
  // Parts of one version are filed under its address and validator.
  const representation = metadata.validatorHeader === "repr-digest" ? undefined
    : await resumeIdentity(String(metadata.total), url, metadata.validator);
  const parts: (Blob | undefined)[] = options.parts?.length === count ? options.parts.slice() : new Array(count);
  if (options.prefix) {
    for (let offset = 0; offset < options.prefix.size; offset += CHUNK_BYTES) {
      const index = offset / CHUNK_BYTES;
      const slice = options.prefix.slice(offset, offset + CHUNK_BYTES);
      if (slice.size > (parts[index]?.size ?? 0)) parts[index] = slice;
    }
  }
  const generation = t.dropped;
  const controller = new AbortController();
  const abort = () => controller.abort(t.signal.reason);
  t.signal.addEventListener("abort", abort, { once: true });
  if (t.signal.aborted) abort();
  const rangeSignal = controller.signal;
  let next = 0;
  let received = parts.reduce((total, part) => total + (part?.size ?? 0), 0);
  const resumed = received > 0;
  let lastUpdate = 0;
  const partial = new Map<number, number>();
  function bytesInHand(): number {
    let bytes = received;
    for (const count of partial.values()) bytes += count;
    return bytes;
  }
  t.report({ kind: "downloading" }, received, metadata.total);

  // Additive increase, multiplicative decrease: a busy origin or a lost
  // connection drops new parts to one connection. Each drop opens a new
  // epoch, and only a part started within it proves that the origin copes:
  // that completion adds one connection back.
  const maxWorkers = Math.min(WORKERS, count);
  let limit = resumed ? 1 : maxWorkers;
  let epoch = 0;
  let active = 0;
  let failure: { error: unknown } | undefined;
  let whole: DirectFile | undefined;
  const running = new Set<Promise<void>>();

  async function worker(): Promise<void> {
    while (next < count && !failure && !whole && active <= limit) {
      const index = next++;
      const startedIn = epoch;
      const prior = parts[index];
      const partStart = index * CHUNK_BYTES;
      const start = partStart + (prior?.size ?? 0);
      const end = Math.min(partStart + CHUNK_BYTES, metadata.total) - 1;
      if (start > end) continue;
      try {
        const bytes = await fetchMediaRange(url, start, end, metadata, {
          signal: rangeSignal, fetchFile, onWholeResponse: options.onWholeResponse,
          onRetry: retry => {
            // In-flight workers finish their own part; new parts wait for one connection.
            if (retry.httpStatus === 429 || retry.httpStatus === 503 || (retry.httpStatus === null && bytesInHand() > 0)) {
              limit = 1;
              epoch++;
            }
            retrying(t, bytesInHand, metadata.total, { index: index + 1, count })(retry);
          },
          onBytes: bytes => {
            partial.set(index, bytes);
            if (performance.now() - lastUpdate >= 250) {
              lastUpdate = performance.now();
              t.report({ kind: "downloading" }, bytesInHand(), metadata.total);
            }
          },
          keepPartial: kept => {
            parts[index] = prior ? new Blob([prior, kept]) : kept;
            received += kept.size;
            partial.delete(index);
          },
        });
        partial.delete(index);
        if (!(bytes instanceof Uint8Array)) {
          whole = bytes.whole;
          controller.abort();
          return;
        }
        parts[index] = new Blob(prior ? [prior, bytes as BlobPart] : [bytes as BlobPart]);
        received += bytes.byteLength;
        t.report({ kind: "downloading" }, bytesInHand(), metadata.total);
        if (startedIn === epoch && limit < maxWorkers) {
          limit++;
          spawn();
        }
      } catch (error) {
        partial.delete(index);
        if (!failure && !whole) {
          failure = { error };
          controller.abort();
        }
        return;
      }
    }
  }

  function spawn(): void {
    while (active < limit && next < count && !failure && !whole) {
      active++;
      const run: Promise<void> = worker().finally(() => {
        active--;
        running.delete(run);
      });
      running.add(run);
    }
  }

  try {
    spawn();
    while (running.size) await Promise.allSettled([...running]);
  } finally {
    t.signal.removeEventListener("abort", abort);
  }
  if (whole) return { kind: "whole", file: whole };
  if (failure) {
    const { error } = failure;
    // Parts stay valid for a later request only when the failure leaves them
    // so, and only while no response has replaced their version meanwhile.
    if (received > 0 && !t.signal.aborted && retainedOutcome(error) === "keep" && t.dropped === generation) {
      if (representation) hold(t, { kind: "ranges", representation, metadata, parts }, url, metadata);
      else {
        const prefix = contiguousRangePrefix(parts);
        if (prefix.size) {
          const resource = await resumeIdentity("file", url, "");
          // A whole-file checksum remains authoritative across connections.
          hold(t, { kind: "prefix", entry: resource, resource, prefix, total: metadata.total, metadata }, url, metadata);
        }
      }
    }
    throw error;
  }
  const blob = new Blob(parts.filter((part): part is Blob => part !== undefined), { type: options.mime ?? "" });
  if (blob.size !== metadata.total) throw new TransferError("range-mismatch", { url, received: blob.size, expected: metadata.total });
  await verifyFileDigest(blob, metadata.digest, t.signal, url);
  return { kind: "ranges", blob, resumed };
}

/**
 * Reads a complete-file response. Magic bytes decide before any length: a
 * page or data document is refused at once, never kept and never retried,
 * and the lengths and validators the response states are judged only after
 * its first bytes identify it. An HTTP 200 under a newer validator than the
 * bytes it would replace is the current file, sent whole (If-Range): those
 * bytes are dropped and the response is read as the file. A body that stops
 * before its announced length returns its identified media prefix as an
 * InterruptedBody and keeps it as a checkpoint; bytes too few to identify,
 * of unknown total, or content-encoded are not kept.
 */
async function readWholeFile(t: Transfer, url: string, response: Response, signal: AbortSignal, receivedBytes: () => void,
  options: WholeFileOptions): Promise<BodyRead> {
  const headers = responseHeaders(response);
  const source = response.url || url;
  if (!response.body) throw new TransferError("body-short", { url: source, received: 0, expected: null }, false);
  let conflict: TransferError | undefined;
  let stated: number | null = null;
  try { stated = statedLength(response.status, headers, source); }
  catch (error) {
    if (!isTransferError(error)) throw error;
    conflict = error;
  }
  const { known } = options;
  const replaced = !!known && !conflict && ((stated !== null && stated !== known.total) || !sameVersion(headers, known.metadata));
  if (replaced && options.replaying) {
    drop(t);
    t.report({ kind: "restarting", cause: "retained-rejected" }, 0, stated);
  }
  const sameFile = !!known && !replaced;
  const replaying = sameFile ? options.replaying : undefined;
  const expected = replaying ? options.expected : undefined;
  const total = stated ?? (sameFile ? known.total : null);
  // Folded into Blobs as the body arrives: only the head and the last few chunks stay in the engine document.
  const parts = new BlobParts();
  const head = new Uint8Array(4096);
  let received = 0;
  let container: OutputContainer | undefined;
  let lastUpdate = 0;
  let failure: TransferError | undefined;
  function identify(): OutputContainer {
    const actual = requireDirectVideo(head.subarray(0, Math.min(received, head.length)), headers);
    if (expected && actual !== expected) throw {
      code: "verification_container", severity: "terminal", probeError: "The file type changed between requests",
    } satisfies JobError;
    return actual;
  }
  function stopped(cause: unknown): TransferError {
    const transfer = transportFailure(cause, source, "body", received, total);
    if (transfer instanceof TransferError) return transfer;
    throw transfer;
  }
  function reportRead(): void {
    if (replaying && received < replaying.size) t.report({ kind: "resuming" }, replaying.size, total);
    else t.report({ kind: "downloading" }, received, total);
  }
  const reader = response.body.getReader();
  reportRead();
  try {
    for (;;) {
      if (signal.aborted) {
        failure = stopped(signal.reason);
        break;
      }
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); }
      catch (error) {
        const cause = signal.aborted ? signal.reason : error;
        reportHttpBody(response, received, httpReadFailure(cause));
        failure = stopped(cause);
        break;
      }
      if (next.done) {
        reportHttpBody(response, received, total !== null && received < total ? "ended-early" : "complete");
        break;
      }
      const { value } = next;
      receivedBytes();
      if (received < head.length) head.set(value.subarray(0, head.length - received), received);
      received += value.byteLength;
      if (total !== null && received > total) throw new TransferError("body-long", { url: source, received, expected: total });
      if (!container && received >= head.length) container = identify();
      parts.append(value);
      if (conflict && container) break;
      if (performance.now() - lastUpdate >= 250) {
        lastUpdate = performance.now();
        reportRead();
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* Already consumed or interrupted. */ }
    reader.releaseLock();
  }
  const identity = identifyResponse(head.subarray(0, Math.min(received, head.length)), headers);
  if (identity.kind === "document") throw { code: "unexpected_media_response", severity: "terminal", response: identity.response } satisfies JobError;
  if (conflict) throw conflict;

  // Every announced byte arrived, even if the stream failed after the last one.
  if (total !== null ? received === total : failure === undefined) {
    container ??= identify();
    t.report({ kind: "downloading" }, received, total);
    const blob = parts.toBlob(DIRECT_MEDIA_TYPES[container]);
    // A whole-file checksum the server states is always checked.
    const digest = (sameFile ? known.metadata?.digest : undefined) ?? (total !== null ? resumeMetadata(headers, total)?.digest : undefined);
    await verifyFileDigest(blob, digest, t.signal, source);
    return { kind: "file", file: { blob, container, resumed: false } };
  }

  // The server delivered less than it announced, or the connection dropped.
  // A clean early end is the server's answer: repeating the request is not resuming.
  const stop = failure ?? new TransferError("body-short", { url: source, received, expected: total }, false);
  if (identity.kind !== "media" || total === null || received === 0 || !identityEncoded(headers)) throw stop;
  const prefix = parts.toBlob();
  const observed = resumeMetadata(headers, total);
  const digest = sameFile ? known.metadata?.digest : undefined;
  const metadata: RangeMetadata | null = digest
    ? observed ? { ...observed, digest } : { total, validatorHeader: "repr-digest", validator: digest, digest }
    : observed;
  const kept = expected ?? container ?? (received >= head.length ? identity.container : undefined);
  if (!replaying || received > replaying.size) {
    // The network attempt may have timed out. Comparing bytes already
    // in memory belongs to the live job and still honors user cancellation.
    if (replaying) {
      t.report({ kind: "rechecking" }, replaying.size, total);
      await compareFilePrefix(replaying, total, source, t.resume.signal, async (start, end) =>
        new Uint8Array(await prefix.slice(start, end).arrayBuffer()));
    }
    const entry = await resumeIdentity("file", url, "");
    const resource = source === url ? entry : await resumeIdentity("file", source, "");
    hold(t, { kind: "prefix", entry, resource, total, prefix, metadata, container: kept }, source, metadata);
  }
  return { kind: "interrupted", prefix, total, metadata, url: source, headers, expected: kept,
    earlier: sameFile ? known.metadata : null, cause: stop };
}

