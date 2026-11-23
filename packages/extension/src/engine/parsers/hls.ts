import { Parser } from "m3u8-parser";
import type {
  HlsKeyPlan,
  StreamDescriptor,
  UserChoice,
  Variant,
} from "@savemedia/core";
import { report, type PrepareRequests, type ProgressFn } from "../job";
import { fetchWithRetry } from "../net/fetch-with-retry";
import { classifyPlaylistReread } from "../net/error-classification";
import { readManifestText } from "../net/manifest-text";
import { requireManifestAtSave } from "../manifest-at-save";
import { checkManifestSize, coveredFileEnd, coveredFileWithGaps, hlsEncryptionOf, parseHlsKeyDeclarations, pickHlsAudioRendition, pickVariant, planHlsKeys } from "@savemedia/core";
import type { FileRange, HlsKeyDeclaration, HlsSegmentKey, JobError } from "@savemedia/core";

/**
 * Runtime media-playlist parser used by the engine after the master is
 * resolved to a variant. The core `@savemedia/core` parser produces typed
 * StreamDescriptors; this lighter helper is just the URL list + per-segment
 * IV/sequence the engine needs to fetch and decrypt.
 *
 * **The runtime playlist is the authority for HLS keys**: the master rarely
 * carries them (EXT-X-SESSION-KEY is optional), so the engine judges the
 * media playlist's own `keyDeclarations` with the same planHlsKeys policy
 * classify used, never the variant's earlier segmentRef.
 */

export interface RuntimeSegment {
  readonly uri: string;
  readonly duration: number;
  /** The AES-128 key covering this segment; null when it is clear. */
  readonly key: HlsSegmentKey | null;
}

export interface RuntimePlaylist {
  readonly initSegmentUrl: string | null;
  /** The key covering the init section, when an EXT-X-KEY precedes EXT-X-MAP. */
  readonly initKey: HlsSegmentKey | null;
  readonly segments: readonly RuntimeSegment[];
  readonly targetDuration: number | null;
  readonly isVod: boolean;
  /**
   * How the playlist addresses its parts (EXT-X-BYTERANGE). "addresses":
   * every part under an address of its own. A file: the parts are byte
   * ranges of this one file, from its first byte and in order, up to
   * `bytes`; the file as a whole is then the stream, and it is read as one.
   * A transport stream's ranges leave nothing out. A fragmented MP4's may
   * leave out stretches between them (`gaps`): packagers keep the file's
   * index there, which a playlist has no use for. Whether a gap holds
   * nothing but such boxes is checked once the file is read (file-gaps.ts).
   * "scattered": byte ranges that do not add up to one whole file.
   */
  readonly ranges: "addresses" | "scattered" | { readonly url: string; readonly bytes: number; readonly gaps: readonly FileRange[] };
  /** A fragmented MP4 playlist that names another header (EXT-X-MAP) part-way: its parts are not one MP4. */
  readonly initChanges: boolean;
  /**
   * Every EXT-X-KEY in the playlist, read from the text rather than from
   * m3u8-parser: the library drops KEYFORMAT, and KEYFORMAT is what
   * separates a key served in the clear from one a CDM holds.
   */
  readonly keyDeclarations: readonly HlsKeyDeclaration[];
}

/** Throws manifest_too_large, before anything is parsed, for a playlist with more segments than a job reads. */
export function parseHlsMediaPlaylistRuntime(text: string, playlistUrl: string): RuntimePlaylist {
  checkManifestSize("hls", text, playlistUrl);
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const m = parser.manifest;
  const startSeq = (m.mediaSequence ?? 0) as number;
  const firstMap = m.segments?.find(s => s.map?.uri)?.map ?? null;
  const keyOf = (key: { uri?: string; iv?: ArrayBufferView } | undefined, mediaSequence: number): HlsSegmentKey | null =>
    key?.uri ? { keyUri: new URL(key.uri, playlistUrl).href, iv: key.iv ? ivToBytes(key.iv) : null, mediaSequence } : null;
  const segs: RuntimeSegment[] = (m.segments ?? []).map((s, i) => ({
    uri: new URL(s.uri, playlistUrl).href,
    duration: s.duration,
    key: keyOf(s.key, startSeq + i),
  }));

  const initSegmentUrl = firstMap?.uri ? new URL(firstMap.uri, playlistUrl).href : null;
  const parts = m.segments ?? [];
  const ranged = parts.some(s => s.byterange || s.map?.byterange);
  let ranges: RuntimePlaylist["ranges"] = ranged ? "scattered" : "addresses";
  const file = segs[0]?.uri;
  // One file: one address for the header and every part, the same header for every part, and ranges that cover the file.
  const sameMap = (s: (typeof parts)[number]): boolean => s.map?.uri === firstMap?.uri
    && s.map?.byterange?.offset === firstMap?.byterange?.offset && s.map?.byterange?.length === firstMap?.byterange?.length;
  if (ranged && file !== undefined && (initSegmentUrl ?? file) === file && segs.every(s => s.uri === file) && parts.every(sameMap)) {
    if (initSegmentUrl) {
      const covered = coveredFileWithGaps([firstMap?.byterange, ...parts.map(s => s.byterange)]);
      if (covered) ranges = { url: file, bytes: covered.end, gaps: covered.gaps };
    } else {
      const bytes = coveredFileEnd(parts.map(s => s.byterange));
      if (bytes !== null) ranges = { url: file, bytes, gaps: [] };
    }
  }

  return {
    ranges,
    // Every part of a fragmented MP4 follows the header the playlist named last. One header is one MP4.
    initChanges: firstMap !== null && !parts.every(s => !s.map?.uri || sameMap(s)),
    initSegmentUrl,
    // Without an IV attribute, players derive the init section's IV from sequence number 0.
    initKey: keyOf((firstMap as { key?: { uri?: string; iv?: ArrayBufferView } } | null)?.key, 0),
    segments: segs,
    targetDuration: typeof m.targetDuration === "number" ? m.targetDuration : null,
    isVod: m.endList === true,
    keyDeclarations: parseHlsKeyDeclarations(text, playlistUrl),
  };
}

/**
 * The runtime key check, before any key or segment is requested. A live
 * playlist is refused because it has no end to save. Encryption is refused
 * only when its key does not reach the player in the clear: AES-128 with an
 * identity KEYFORMAT is fetched over the player's own HTTP and used; every
 * other method or key format belongs to a CDM key system and is never touched.
 */
export function requireSupportedHlsVod(media: RuntimePlaylist, playlistUrl: string): HlsKeyPlan {
  if (!media.isVod) {
    throw { code: "hls_live_unsupported", severity: "terminal", manifestUrl: playlistUrl };
  }
  const plan = planHlsKeys(media.keyDeclarations);
  if (plan.kind === "drm") {
    throw { code: "cdm_required", severity: "terminal", keySystem: plan.keySystem };
  }
  // Byte ranges are saved when they are one whole clear file. Ranges that do
  // not add up to one, or that are each encrypted on their own, would be
  // joined into a file that does not play, so they are not requested.
  if (media.ranges === "scattered" || (media.ranges !== "addresses" && (media.initKey || media.segments.some(s => s.key)))) {
    throw { code: "hls_layout_unsupported", severity: "terminal", manifestUrl: playlistUrl, layout: "byte-ranges" } satisfies JobError;
  }
  // Parts written one after another behind the first header are an MP4 only while that header describes all
  // of them. A playlist that changes its header part-way (another picture size after an inserted clip) would
  // be saved as a file that stops playing there, so nothing of it is requested and the reason is said.
  if (media.initChanges) {
    throw { code: "hls_layout_unsupported", severity: "terminal", manifestUrl: playlistUrl, layout: "init-changes" } satisfies JobError;
  }
  return plan;
}

function copyToUint8(view: ArrayBufferView): Uint8Array {
  const dst = new Uint8Array(view.byteLength);
  dst.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return dst;
}

/**
 * m3u8-parser hands back an EXT-X-KEY IV as a Uint32Array of four big-endian
 * words. Copying its raw bytes on a little-endian machine reverses each word
 * and yields an IV that decrypts to garbage, so the words are written out
 * big endian here instead.
 */
function ivToBytes(view: ArrayBufferView): Uint8Array {
  if (view instanceof Uint8Array) return copyToUint8(view);
  const out = new Uint8Array(view.byteLength);
  const words = new Uint32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4));
  const dst = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) {
    dst.setUint32(i * 4, words[i]!);
  }
  return out;
}

/**
 * Materializes a demuxed HLS descriptor so dispatch can emit an av-merge plan.
 *
 * After classify, an HLS variant and its linked audio rendition carry only
 * their media-playlist URLs (`segmentUrls` is empty), and dispatch never
 * fetches — it refuses a demuxed variant whose tracks lack concrete URLs. So
 * before dispatch the engine fetches both media playlists and rebuilds the
 * descriptor with each track's init segment, absolutized segment URLs, and
 * runtime encryption (the media playlist, not the master, is the encryption
 * authority): the key policy runs here, and the key of every segment travels
 * with the track so the merge decrypts AES-128 segments with their own key.
 *
 * Anything that is not clear demuxed HLS in need of materialization is
 * returned unchanged. A live media playlist has no end and cannot be merged,
 * so it throws the same terminal error the hls-plain runner uses.
 */
export async function materializeDemuxedHls(
  descriptor: StreamDescriptor,
  choice: UserChoice,
  onProgress: ProgressFn,
  signal: AbortSignal,
  request: typeof fetchWithRetry = fetchWithRetry,
  prepareRequests?: PrepareRequests,
): Promise<StreamDescriptor> {
  if (descriptor.protocol !== "hls" || descriptor.drm) return descriptor;

  const variant = pickVariant(descriptor, choice);
  if (!variant || variant.audioRenditionId === null) return descriptor;
  const rendition = pickHlsAudioRendition(descriptor, variant, choice);
  if (!rendition) return descriptor;

  if (!needsMaterialization(variant) && !needsMaterialization(rendition)) return descriptor;

  report(onProgress, { kind: "playlist" }, 0, null);
  await prepareRequests?.([variant, rendition].flatMap(track => track.segmentRef.kind === "hls-segments" ? [track.segmentRef.playlistUrl] : []));
  const video = await materializeTrack(variant, signal, request);
  const audio = await materializeTrack(rendition, signal, request);

  return {
    ...descriptor,
    variants: descriptor.variants.map(v => (v.id === variant.id ? video : v)),
    audioRenditions: (descriptor.audioRenditions ?? []).map(r => (r.id === rendition.id ? audio : r)),
  };
}

function needsMaterialization(v: Variant): boolean {
  return v.segmentRef.kind === "hls-segments" && v.segmentRef.segmentUrls.length === 0;
}

async function materializeTrack(v: Variant, signal: AbortSignal, request: typeof fetchWithRetry): Promise<Variant> {
  if (!needsMaterialization(v) || v.segmentRef.kind !== "hls-segments") return v;
  const playlistUrl = v.segmentRef.playlistUrl;
  const resp = await request(playlistUrl, signal, "manifest", {credentials: "include", cache: "default"}).catch(err => {
    throw classifyPlaylistReread(err, playlistUrl) ?? err;
  });
  const text = await readManifestText(resp, playlistUrl);
  // Before the playlist is judged: an answer that is no playlist has no end tag either, and is not a live stream.
  requireManifestAtSave("hls", text, playlistUrl);
  const media = parseHlsMediaPlaylistRuntime(text, resp.url || playlistUrl);
  requireSupportedHlsVod(media, playlistUrl);
  return {
    ...v,
    estimatedSize: estimatedTrackBytes(v.bitrate, media.segments) ?? v.estimatedSize,
    segmentRef: media.ranges !== "addresses" && media.ranges !== "scattered"
      // The track is one clear file: it is read whole, up to where its ranges end.
      ? { ...v.segmentRef, initSegmentUrl: null, segmentUrls: [media.ranges.url], encryption: null, segmentKeys: [null], initKey: null,
        fileBytes: media.ranges.bytes, ...(media.ranges.gaps.length ? { fileGaps: media.ranges.gaps } : {}) }
      : {
        ...v.segmentRef,
        initSegmentUrl: media.initSegmentUrl,
        segmentUrls: media.segments.map(s => s.uri),
        encryption: hlsEncryptionOf(media.keyDeclarations),
        // The key of every segment and of the init section, so the merge decrypts each with its own.
        segmentKeys: media.segments.map(s => s.key),
        initKey: media.initKey,
      },
  };
}

/**
 * The master playlist carries BANDWIDTH but no duration, so a variant reaches
 * the save without an expected size. The media playlist completes the
 * estimate: bits/s × summed segment duration (the DASH adapter's formula).
 * EXT-X-MEDIA renditions carry no BANDWIDTH and stay null; per RFC 8216 the
 * variant's BANDWIDTH already covers its audio group. BANDWIDTH is the peak
 * rate, so the estimate leans high: it is for the progress display, and no
 * save is refused on it (core dispatch, statedSize).
 */
export function estimatedTrackBytes(
  bitrate: number | null,
  segments: readonly RuntimeSegment[],
): number | null {
  if (bitrate == null) return null;
  const durationSeconds = segments.reduce((total, s) => total + (s.duration || 0), 0);
  if (durationSeconds <= 0) return null;
  return Math.round((bitrate / 8) * durationSeconds);
}
