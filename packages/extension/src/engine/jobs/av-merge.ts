import { BROWSER_OUTPUT_LIMIT_BYTES, detectContainerFromBytes, isJobError, type AvMergePlan, type JobError, type MergeTrack } from "@savemedia/core";
import { report, type JobResult, type PrepareRequests, type ProgressFn } from "../job";
import { fetchWithRetry } from "../net/fetch-with-retry";
import { classifyNetworkFailure } from "../net/error-classification";
import { TransferError } from "../net/transfer-error";
import { InMemorySink, type JobSink } from "../sink";
import { BlobParts } from "../blob-parts";
import { mergeAvToMp4 } from "../remux/merge-av";
import { inspectTransportFile, refuseProtectedFile, refuseProtectedMedia } from "../verify-direct";
import { TransportStreamInspector, wholePackets } from "../mpeg-ts";
import type { HlsKeyring } from "../crypto/hls-aes";
import { plainInitSection, plainSegmentBytes, playerKeyring, readFile, readSegment, refuseDocument, type Request } from "../hls-segments";
import { PackedAudioFrames, packedAudioHead } from "../packed-audio";
import { refuseMediaInGaps } from "../file-gaps";

export interface AvMergeJobOptions {
  readonly onProgress: ProgressFn;
  readonly signal: AbortSignal;
  readonly sink?: JobSink | undefined;
  readonly request?: typeof fetchWithRetry | undefined;
  readonly prepareRequests?: PrepareRequests | undefined;
}

/**
 * Engine-side job for demuxed sources: fetch the video track's segments and
 * the audio track's segments, join each into a complete byte stream, and mux
 * both into one MP4 with no re-encode (see {@link mergeAvToMp4}). A source
 * whose manifest has no separate audio is saved as its video stream is: with
 * the sound that stream carries itself, or with its picture alone.
 *
 * Joining a track's init segment + ordered media `.m4s` yields a
 * demuxable fragmented-fMP4 stream; a progressive track is a single URL with
 * no init. This is verified end-to-end against real fragmented fixtures.
 * Requests go out as the page's player sends them (hls-segments). An HLS
 * AES-128 segment is decrypted with the key its playlist names for it. The
 * first part of an MP4 track declares any Common Encryption, and every
 * packet of a transport-stream track states its scrambling: both refuse.
 * An HLS audio rendition of bare audio frames (packed audio) is joined
 * without the tag each of its segments opens with, and placed at the time
 * its first tag states (packed-audio).
 *
 * Memory: each track is folded into Blobs as its bytes arrive, the muxer
 * reads those Blobs in slices and writes the MP4 into Blobs again. The engine
 * document holds one segment and a few muxer chunks at a time, never a track.
 * A track that is one file (a DASH representation its manifest keeps in a
 * single file, a progressive rendition) can be as long as the video, so it
 * is not read as a segment: it is folded as it streams in (readFile).
 */
export async function runAvMergeJob(plan: AvMergePlan, options: AvMergeJobOptions): Promise<JobResult> {
  const { onProgress, signal } = options;
  const request = options.request ?? fetchWithRetry;
  await options.prepareRequests?.([...trackAddresses(plan.video), ...(plan.audio ? trackAddresses(plan.audio) : [])]);
  const keyring = playerKeyring(signal, request);
  report(onProgress, { kind: "track", track: "video" }, 0, plan.estimatedBytes);
  // After an outage a track goes on with the segment it was reading: what was received stays held.
  const reconnecting = (bytes: number, waitMs: number): void => report(onProgress, { kind: "reconnecting", waitMs }, bytes, plan.estimatedBytes);
  const video = await fetchTrack(plan.video, "video", { signal, request, keyring }, 0, bytes =>
    report(onProgress, { kind: "track", track: "video" }, bytes, plan.estimatedBytes), reconnecting);

  signal.throwIfAborted();
  let audio: FetchedTrack | null = null;
  if (plan.audio) {
    report(onProgress, { kind: "track", track: "audio" }, video.size, plan.estimatedBytes);
    audio = await fetchTrack(plan.audio, "audio", { signal, request, keyring }, video.size, bytes =>
      report(onProgress, { kind: "track", track: "audio" }, video.size + bytes, plan.estimatedBytes),
    (bytes, waitMs) => reconnecting(video.size + bytes, waitMs));
    signal.throwIfAborted();
  }

  const total = video.size + (audio?.size ?? 0);
  const merged = await mergeAvToMp4(video.blob, audio?.blob ?? null, fraction =>
    report(onProgress, { kind: "merging", fraction }, total, total), audio?.startSeconds ?? null, signal);
  signal.throwIfAborted();

  const filename = replaceExt(plan.outputFilename, "mp4");
  const sink = options.sink ?? new InMemorySink("video/mp4");
  await sink.open(filename, total);
  await sink.write(merged);
  report(onProgress, { kind: "finalizing" }, total, total);
  return sink.close();
}

function trackUrls(track: MergeTrack): string[] {
  return track.initUrl ? [track.initUrl, ...track.segmentUrls] : [...track.segmentUrls];
}

/** Every address the player requests for a track, its keys included. */
function trackAddresses(track: MergeTrack): string[] {
  const keys = [track.initKey, ...(track.segmentKeys ?? [])].flatMap(key => key ? [key.keyUri] : []);
  return [...keys, ...trackUrls(track)];
}

interface TrackRequests {
  readonly signal: AbortSignal;
  readonly request: Request;
  readonly keyring: HlsKeyring;
}

/** One track's bytes, and for bare audio frames, which carry no clock, the time their first tag states. */
interface FetchedTrack {
  readonly blob: Blob;
  readonly size: number;
  readonly startSeconds: number | null;
}

function fetched(blob: Blob, startSeconds: number | null = null): FetchedTrack {
  return { blob, size: blob.size, startSeconds };
}

/** One track as a Blob. `before`: the bytes the job already holds, which count toward what the browser can hold. */
async function fetchTrack(
  track: MergeTrack,
  kind: "video" | "audio",
  { signal, request, keyring }: TrackRequests,
  before: number,
  onBytes: (bytesSoFar: number) => void,
  onWait: (bytesSoFar: number, waitMs: number) => void,
): Promise<FetchedTrack> {
  const urls = trackUrls(track);
  if (urls.length === 0) {
    throw { code: "manifest_malformed", severity: "terminal", url: "", parserError: "merge track has no segments" } satisfies JobError;
  }

  const limit = (bytes: number): void => {
    // No estimate is needed for this limit: the bytes in hand are counted as they arrive.
    if (before + bytes >= BROWSER_OUTPUT_LIMIT_BYTES) {
      throw { code: "output_too_large_for_browser", severity: "terminal",
        estimatedBytes: before + bytes, limitBytes: BROWSER_OUTPUT_LIMIT_BYTES, measured: true } satisfies JobError;
    }
  };
  const failedRead = (err: unknown, index: number, url: string): unknown => {
    if (signal.aborted || isJobError(err)) return err;
    return classifyNetworkFailure(err, "segment", url) ?? {
      code: "segment_budget_exhausted",
      severity: "terminal",
      failedSegments: [index],
      totalSegments: urls.length,
    } satisfies JobError;
  };

  if (!track.initUrl && urls.length === 1 && !track.segmentKeys?.[0]) {
    // The track is one file with no key. Its first bytes say what it is before the rest is read.
    const url = urls[0]!;
    let lastReport = 0;
    const { file, identity: { container, startSeconds } } = await readFile(url, signal, request, head => {
      const container = detectContainerFromBytes(head);
      if (container === "unknown") refuseDocument(head);
      // A file of bare audio frames has one tag, at its start, which the muxer's reader passes over itself.
      return { container, startSeconds: container === "unknown" && kind === "audio" ? packedAudioHead(head)?.startSeconds ?? null : null };
    }, bytes => {
      limit(bytes);
      // A report per chunk would flood the popup.
      if (performance.now() - lastReport < 250) return;
      lastReport = performance.now();
      onBytes(bytes);
    }).catch(err => { throw failedRead(err, 0, url); });
    if (container === "mpegts") (await inspectTransportFile(file, signal)).finish();
    else await refuseProtectedFile(file, signal);
    onBytes(file.size);
    // A manifest that states where the file ends: the track is those bytes, no fewer and no more.
    const stated = track.fileBytes ?? file.size;
    if (file.size < stated) throw failedRead(new TransferError("network", { url, during: "body", received: file.size, expected: stated }, false), 0, url);
    const whole = file.size > stated ? file.slice(0, stated) : file;
    // What a playlist's byte ranges leave out of the file must hold no media: then the file is the track.
    if (track.fileGaps?.length) await refuseMediaInGaps(whole, track.fileGaps, url, signal);
    return fetched(whole, startSeconds);
  }

  const parts = new BlobParts();
  let transport: TransportStreamInspector | null = null;
  let packed: PackedAudioFrames | null = null;
  let startSeconds: number | null = null;
  for (const [index, url] of urls.entries()) {
    signal.throwIfAborted();
    const body = await readSegment(url, signal, request, waitMs => onWait(parts.size, waitMs)).catch(err => { throw failedRead(err, index, url); });
    const isInit = track.initUrl !== null && index === 0;
    const key = (isInit ? track.initKey : track.segmentKeys?.[track.initUrl !== null ? index - 1 : index]) ?? null;
    // Refusals name the stream's host, never a signed segment address.
    const stream = originOf(url);
    let plain = isInit ? await plainInitSection(body, key, keyring, stream) : await plainSegmentBytes(body, key, keyring, stream);
    if (index === 0) {
      // The init segment, or a track's first part, says what the track is.
      const container = detectContainerFromBytes(plain);
      if (container === "unknown") refuseDocument(plain);
      const bare = container === "unknown" && kind === "audio" && !isInit ? packedAudioHead(plain) : null;
      if (bare) {
        packed = new PackedAudioFrames(bare.frames);
        startSeconds = bare.startSeconds;
      } else if (container === "mpegts") transport = new TransportStreamInspector();
      else refuseProtectedMedia(plain);
    }
    if (packed) {
      // Bare audio frames: the tag each segment opens with is no audio and would end the track where it stands.
      const frames = packed.push(plain);
      if (!frames) throw { code: "unexpected_media_response", severity: "terminal", response: "unsupported", host: hostOf(url) } satisfies JobError;
      plain = frames;
    }
    // A transport stream segment that was cut inside its last packet: the next one's packets stay in step.
    if (transport) plain = wholePackets(plain);
    transport?.inspect(plain);
    parts.append(plain);
    limit(parts.size);
    onBytes(parts.size);
  }
  transport?.finish();
  return fetched(parts.toBlob(), startSeconds);
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

function replaceExt(filename: string, ext: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return `${filename}.${ext}`;
  return `${filename.slice(0, idx)}.${ext}`;
}
