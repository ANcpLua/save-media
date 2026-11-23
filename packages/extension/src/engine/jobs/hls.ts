import type {
  FileRange,
  HlsPlainPlan,
  JobError,
  StreamDescriptor,
  Variant,
} from "@savemedia/core";
import { isJobError } from "@savemedia/core";
import { report, type JobResult, type PrepareRequests, type ProgressFn } from "../job";
import {
  estimatedTrackBytes,
  parseHlsMediaPlaylistRuntime,
  type RuntimePlaylist,
  type RuntimeSegment,
  requireSupportedHlsVod,
} from "../parsers/hls";
import { fetchWithRetry } from "../net/fetch-with-retry";
import type { HlsKeyring } from "../crypto/hls-aes";
import { classifyNetworkFailure, classifyPlaylistReread } from "../net/error-classification";
import { readManifestText } from "../net/manifest-text";
import { requireManifestAtSave } from "../manifest-at-save";
import { InMemorySink, type JobSink } from "../sink";
import { BlobParts } from "../blob-parts";
import { refuseMediaInGaps } from "../file-gaps";
import { TransportStreamInspector, wholePackets } from "../mpeg-ts";
import { remuxTsToMp4 } from "../remux/ts-to-mp4";
import { inspectTransportFile, refuseProtectedMp4, validateDirectBlob } from "../verify-direct";
import { TransferError } from "../net/transfer-error";
import { AS_THE_PLAYER, plainInitSection, plainSegmentBytes, playerKeyring, readFile, readSegment, refuseDocument } from "../hls-segments";

export interface HlsJobOptions {
  readonly onProgress: ProgressFn;
  readonly signal: AbortSignal;
  readonly sink?: JobSink | undefined;
  readonly request?: typeof fetchWithRetry | undefined;
  readonly prepareRequests?: PrepareRequests | undefined;
}

type Request = typeof fetchWithRetry;

/**
 * Resolve the media playlist before choosing an output. Runtime key
 * declarations govern segment reads. Program tables decide whether the
 * result can be an MP4 or needs the original transport packets.
 */
export async function runHlsJob(
  plan: HlsPlainPlan,
  descriptor: StreamDescriptor,
  options: HlsJobOptions,
): Promise<JobResult> {
  const { onProgress, signal } = options;
  const request = options.request ?? fetchWithRetry;
  const variant = findVariant(descriptor, plan.variantId);
  if (!variant) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.source.kind === "hls-manifest" ? descriptor.source.manifestUrl : descriptor.pageUrl,
      parserError: "selected variant not in manifest",
    };
  }

  const playlistUrl = playlistUrlOf(variant);
  if (!playlistUrl) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.pageUrl,
      parserError: "variant missing media playlist URL",
    };
  }

  report(onProgress, { kind: "playlist" }, 0, null);
  await options.prepareRequests?.([playlistUrl]);
  const playlistResp = await request(playlistUrl, signal, "manifest", AS_THE_PLAYER).catch(err => {
    throw classifyPlaylistReread(err, playlistUrl) ?? err;
  });
  const playlistText = await readManifestText(playlistResp, playlistUrl);
  // Before the playlist is judged: an answer that is no playlist has no segments and no end tag, and is neither damaged nor live.
  requireManifestAtSave("hls", playlistText, playlistUrl);
  const media = parseHlsMediaPlaylistRuntime(playlistText, playlistResp.url || playlistUrl);

  if (media.segments.length === 0) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: playlistUrl,
      parserError: "media playlist has zero segments",
    };
  }

  requireSupportedHlsVod(media, playlistUrl);
  // A playlist of byte ranges of one file states the size of the stream: one that will not fit is refused
  // here, with that size, before the first key or segment is requested. Nothing else states a size. The
  // master playlist's bit rate is the peak rate, so that rate over the playlist's length leans high: it
  // tells the progress display what to expect and never refuses a save. The count of received bytes stops
  // a stream at the limit.
  const statedBytes = typeof media.ranges === "object" ? media.ranges.bytes : null;
  await options.prepareRequests?.(playlistAddresses(media));
  const keyring = playerKeyring(signal, request);

  const estimatedBytes = plan.estimatedBytes ?? statedBytes ?? estimatedTrackBytes(variant.bitrate, media.segments);
  return fetchSegments(media, { plan, onProgress, signal, sink: options.sink, request, playlistUrl, estimatedBytes }, keyring);
}

/** Every address the player requests for this playlist: keys, the init segment and the segments. */
function playlistAddresses(media: RuntimePlaylist): string[] {
  const keys = media.keyDeclarations.flatMap(key => key.keyUri ? [key.keyUri] : []);
  return [...keys, ...(media.initSegmentUrl ? [media.initSegmentUrl] : []), ...media.segments.map(s => s.uri)];
}

type Layout = Extract<JobError, { code: "hls_layout_unsupported" }>["layout"];

/** Bytes that are not the segment the layout needs: a document says what it is, anything else names the layout. */
function unsupportedLayout(manifestUrl: string, layout: Layout, bytes?: Uint8Array): never {
  if (bytes) refuseDocument(bytes);
  throw { code: "hls_layout_unsupported", severity: "terminal", manifestUrl, layout } satisfies JobError;
}

interface SegmentJob {
  readonly plan: HlsPlainPlan;
  readonly onProgress: ProgressFn;
  readonly signal: AbortSignal;
  readonly sink?: JobSink | undefined;
  readonly request: Request;
  /** The media playlist the segments come from; refusals name it, never a segment address. */
  readonly playlistUrl: string;
  /** The size the plan or the media playlist implies, when either does. */
  readonly estimatedBytes: number | null;
}

/**
 * A playlist whose parts are byte ranges of one file: the file is the stream.
 * It is read once, whole, folded into Blobs as it arrives, and cut where the
 * ranges end. A fragmented MP4 is saved as it is, after the checks a direct
 * file gets; a transport stream goes on to the remux like any other.
 */
async function fetchOneFile(file: { readonly url: string; readonly bytes: number; readonly gaps: readonly FileRange[] }, fragmented: boolean,
  job: SegmentJob): Promise<JobResult> {
  const { plan, onProgress, signal, request, playlistUrl } = job;
  let lastReport = 0;
  report(onProgress, { kind: "downloading" }, 0, file.bytes);
  const read = await readFile(file.url, signal, request, head => {
    // The first bytes say whether this is the kind of file the playlist describes, before the rest is read.
    if (fragmented ? !(head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) : head[0] !== 0x47) {
      unsupportedLayout(playlistUrl, fragmented ? "init-boxes" : "not-transport-stream", head);
    }
  }, bytes => {
    // A report per chunk would flood the popup.
    if (performance.now() - lastReport < 250) return;
    lastReport = performance.now();
    report(onProgress, { kind: "downloading" }, bytes, file.bytes);
  }).catch(err => {
    signal.throwIfAborted();
    if (isTerminalThrown(err)) throw err;
    throw classifyNetworkFailure(err, "segment", file.url) ?? {
      code: "segment_budget_exhausted", severity: "terminal", failedSegments: [0], totalSegments: 1,
    } satisfies JobError;
  });
  if (read.file.size < file.bytes) {
    throw classifyNetworkFailure(new TransferError("network", { url: file.url, during: "body", received: read.file.size, expected: file.bytes }, false),
      "segment", file.url)!;
  }
  // The stream is the bytes the playlist's ranges name, no more.
  const stream = read.file.size > file.bytes ? read.file.slice(0, file.bytes) : read.file;
  signal.throwIfAborted();
  if (!fragmented) return saveTransportStream(stream, await inspectTransportFile(stream, signal), job);

  // What the ranges leave out between them must hold no media: then the file is the stream, as it is.
  await refuseMediaInGaps(stream, file.gaps, playlistUrl, signal);
  await validateDirectBlob(stream, "mp4", signal);
  const sink = job.sink ?? new InMemorySink("video/mp4");
  await sink.open(replaceExt(plan.outputFilename, "mp4"), stream.size);
  try {
    await sink.write(stream);
    signal.throwIfAborted();
    report(onProgress, { kind: "finalizing" }, stream.size, stream.size);
    return await sink.close();
  } catch (err) {
    await sink.abort();
    throw err;
  }
}

async function fetchSegments(media: RuntimePlaylist, job: SegmentJob, keyring: HlsKeyring): Promise<JobResult> {
  const { onProgress, signal, request, playlistUrl } = job;
  const { initSegmentUrl, segments } = media;
  if (media.ranges !== "addresses" && media.ranges !== "scattered") return fetchOneFile(media.ranges, initSegmentUrl !== null, job);
  if (initSegmentUrl) return fetchFmp4Segments(initSegmentUrl, media, job, keyring);

  // Folded into Blobs as the segments arrive: the engine document holds one segment, never the stream.
  const parts = new BlobParts();
  const transport = new TransportStreamInspector();
  let total = 0;
  for (const [index, seg] of segments.entries()) {
    signal.throwIfAborted();
    try {
      const body = await readSegment(seg.uri, signal, request, waitMs => report(onProgress, { kind: "reconnecting", waitMs }, total, null));
      const plain = await plainSegmentBytes(body, seg.key, keyring, playlistUrl);
      if (plain[0] !== 0x47) unsupportedLayout(playlistUrl, "not-transport-stream", plain);
      const bytes = wholePackets(plain);
      total += bytes.byteLength;
      transport.inspect(bytes);
      parts.append(bytes);
      report(onProgress, { kind: "segment", index: index + 1, count: segments.length }, total, null);
    } catch (err) {
      signal.throwIfAborted();
      if (isTerminalThrown(err)) throw err;
      throw classifyNetworkFailure(err, "segment", seg.uri) ?? {
        code: "segment_budget_exhausted", severity: "terminal",
        failedSegments: [index], totalSegments: segments.length,
      } satisfies JobError;
    }
  }

  signal.throwIfAborted();
  const stream = parts.toBlob("video/mp2t");
  parts.clear();
  return saveTransportStream(stream, transport, job);
}

/** A whole transport stream, every packet of it inspected: remuxed to MP4, or kept as it is. */
async function saveTransportStream(stream: Blob, transport: TransportStreamInspector, job: SegmentJob): Promise<JobResult> {
  const { plan, onProgress, signal } = job;
  const total = stream.size;
  // An MP4 whenever it can carry every audio and video stream; metadata such
  // as timed ID3 may be left out. Otherwise the original packets are kept.
  const { keepsTransport } = transport.finish();
  let mp4: Blob | null = null;
  if (!keepsTransport) {
    report(onProgress, { kind: "remuxing", fraction: 0 }, total, total);
    // The remux reads the stream's Blob in slices and writes the MP4 into
    // Blobs: neither is held in the engine document's memory.
    try {
      mp4 = await remuxTsToMp4(stream, fraction => report(onProgress, { kind: "remuxing", fraction }, total, total), signal);
      await assertMp4(mp4);
    } catch {
      // A transport stream that cannot be put into an MP4 is kept as it is. A clock that starts again
      // (clips joined in on the server) is known before the remux (TransportStreamInspector); this is for
      // whatever else the muxer does not accept. Every packet of the stream was inspected, so the original
      // packets are a file that plays, and the same save again would stop the same way: nothing to retry.
      signal.throwIfAborted();
      mp4 = null;
    }
  }
  const filename = replaceExt(plan.outputFilename, mp4 ? "mp4" : "ts");
  const sink = job.sink ?? new InMemorySink(mp4 ? "video/mp4" : "video/mp2t");
  await sink.open(filename, total);
  try {
    await sink.write(mp4 ?? stream);
    signal.throwIfAborted();
    report(onProgress, { kind: "finalizing" }, total, total);
    return await sink.close();
  } catch (err) {
    await sink.abort();
    throw err;
  }
}

async function fetchFmp4Segments(
  initSegmentUrl: string,
  media: RuntimePlaylist,
  job: SegmentJob,
  keyring: HlsKeyring,
): Promise<JobResult> {
  const { plan, onProgress, signal, request, playlistUrl } = job;
  const segments: readonly RuntimeSegment[] = media.segments;
  const failed: number[] = [];
  let bytesWritten = 0;
  let sink: JobSink | null = job.sink ?? null;
  let opened = false;
  let currentUrl = initSegmentUrl;
  let currentIndex = -1;

  try {
    signal.throwIfAborted();
    report(onProgress, { kind: "downloading" }, 0, null);
    // The parts already written to the sink stay there while a reconnect waits.
    const reconnecting = (waitMs: number): void => report(onProgress, { kind: "reconnecting", waitMs }, bytesWritten, null);
    const initBytes = await plainInitSection(await readSegment(initSegmentUrl, signal, request, reconnecting), media.initKey, keyring, playlistUrl);
    assertFmp4InitSegment(initBytes, playlistUrl);

    const filename = replaceExt(plan.outputFilename, "mp4");
    if (!sink) sink = new InMemorySink("video/mp4");
    await sink.open(filename, job.estimatedBytes);
    opened = true;
    await sink.write(initBytes);
    bytesWritten += initBytes.byteLength;
    report(onProgress, { kind: "downloading" }, bytesWritten, null);

    for (let i = 0; i < segments.length; i++) {
      signal.throwIfAborted();
      const seg = segments[i]!;
      currentUrl = seg.uri;
      currentIndex = i;
      const body = await plainSegmentBytes(await readSegment(seg.uri, signal, request, reconnecting), seg.key, keyring, playlistUrl);
      assertFmp4MediaSegment(body, playlistUrl);
      await sink.write(body);
      bytesWritten += body.byteLength;
      report(onProgress, { kind: "segment", index: i + 1, count: segments.length }, bytesWritten, null);
    }

    signal.throwIfAborted();
    report(onProgress, { kind: "finalizing" }, bytesWritten, bytesWritten);
    return await sink.close();
  } catch (err) {
    if (sink && opened) await sink.abort();
    if (signal.aborted) throw err;
    if (isTerminalThrown(err)) throw err;
    failed.push(currentIndex);
    throw classifyNetworkFailure(err, "segment", currentUrl) ?? {
      code: "segment_budget_exhausted",
      severity: "terminal",
      failedSegments: failed,
      totalSegments: segments.length + 1,
    };
  }
}

async function assertMp4(file: Blob): Promise<void> {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (bytes.length < 8 || bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    throw {
      code: "verification_container",
      severity: "terminal",
      probeError: "TS remux did not produce an MP4 ftyp box",
    };
  }
}

/** The init segment holds the movie box: clear, or declaring Common Encryption that is never touched. */
function assertFmp4InitSegment(bytes: Uint8Array, playlistUrl: string): void {
  const boxes = readIsoBmffBoxes(bytes, playlistUrl);
  const missing = ["ftyp", "moov"].filter(type => !boxes.includes(type));
  if (missing.length > 0) {
    unsupportedLayout(playlistUrl, "init-boxes", bytes);
  }
  refuseProtectedMp4(bytes);
}

function assertFmp4MediaSegment(bytes: Uint8Array, playlistUrl: string): void {
  const boxes = readIsoBmffBoxes(bytes, playlistUrl);
  const missing = ["moof", "mdat"].filter(type => !boxes.includes(type));
  if (missing.length > 0) {
    unsupportedLayout(playlistUrl, "fragment-boxes", bytes);
  }
}

function readIsoBmffBoxes(bytes: Uint8Array, url: string): string[] {
  if (bytes.byteLength < 8) {
    unsupportedLayout(url, "box-structure", bytes);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) {
      unsupportedLayout(url, "box-structure", bytes);
    }

    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) {
        unsupportedLayout(url, "box-structure", bytes);
      }
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      const largeSize = high * 2 ** 32 + low;
      if (!Number.isSafeInteger(largeSize)) {
        unsupportedLayout(url, "box-structure", bytes);
      }
      size = largeSize;
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }

    if (size < headerSize || offset + size > bytes.byteLength) {
      unsupportedLayout(url, "box-structure", bytes);
    }

    boxes.push(String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    ));
    offset += size;
  }
  return boxes;
}

function isTerminalThrown(err: unknown): boolean {
  return isJobError(err) && err.severity === "terminal";
}

function findVariant(d: StreamDescriptor, variantId: string): Variant | null {
  for (const v of d.variants) if (v.id === variantId) return v;
  return d.variants[0] ?? null;
}

function playlistUrlOf(v: Variant): string | null {
  if (v.segmentRef.kind === "hls-segments") return v.segmentRef.playlistUrl;
  return null;
}

function replaceExt(filename: string, ext: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return `${filename}.${ext}`;
  return `${filename.slice(0, idx)}.${ext}`;
}
