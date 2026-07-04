import { Parser } from "m3u8-parser";
import type {
  HlsEncryption,
  StreamDescriptor,
  UserChoice,
  Variant,
} from "@savemedia/core";
import type { ProgressFn } from "../job";
import { fetchWithRetry } from "../net/fetch-with-retry";
import { classifyNetworkFailure } from "../net/error-classification";

/**
 * Runtime media-playlist parser used by the engine after the master is
 * resolved to a variant. The core `@savemedia/core` parser produces typed
 * StreamDescriptors; this lighter helper is just the URL list + per-segment
 * IV/sequence the engine needs to fetch and decrypt.
 *
 * **The runtime parser is the authoritative source for HLS encryption**:
 * the master playlist almost never carries EXT-X-KEY (it lives on the
 * media playlist), so the engine must call this and trust its `encryption`
 * field rather than the one on the variant's segmentRef.
 */

export interface RuntimeEncryption {
  /** Uppercased EXT-X-KEY METHOD: AES-128, SAMPLE-AES, SAMPLE-AES-CTR, … */
  readonly method: string;
  readonly keyUri: string;
  /** IV declared in EXT-X-KEY, if any. Otherwise derived from media sequence. */
  readonly iv: Uint8Array | null;
}

export interface RuntimeSegment {
  readonly uri: string;
  readonly duration: number;
  readonly iv: Uint8Array | null;
  readonly mediaSequence: number | null;
}

export interface RuntimePlaylist {
  readonly initSegmentUrl: string | null;
  readonly segments: readonly RuntimeSegment[];
  readonly targetDuration: number | null;
  readonly isVod: boolean;
  readonly encryption: RuntimeEncryption | null;
}

export function parseHlsMediaPlaylistRuntime(text: string, playlistUrl: string): RuntimePlaylist {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const m = parser.manifest;
  const startSeq = (m.mediaSequence ?? 0) as number;
  const firstMap = m.segments?.find(s => s.map?.uri)?.map ?? null;
  const segs: RuntimeSegment[] = (m.segments ?? []).map((s, i) => ({
    uri: new URL(s.uri, playlistUrl).href,
    duration: s.duration,
    iv: s.key?.iv ? copyToUint8(s.key.iv) : null,
    mediaSequence: startSeq + i,
  }));

  const firstKey = (m.segments ?? []).find(s => s.key)?.key ?? null;
  const encryption: RuntimeEncryption | null = firstKey
    ? {
        method: String(firstKey.method ?? "").toUpperCase(),
        keyUri: new URL(firstKey.uri, playlistUrl).href,
        iv: firstKey.iv ? copyToUint8(firstKey.iv) : null,
      }
    : null;

  return {
    initSegmentUrl: firstMap?.uri ? new URL(firstMap.uri, playlistUrl).href : null,
    segments: segs,
    targetDuration: typeof m.targetDuration === "number" ? m.targetDuration : null,
    isVod: m.endList === true,
    encryption,
  };
}

function copyToUint8(view: ArrayBufferView): Uint8Array {
  const dst = new Uint8Array(view.byteLength);
  dst.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return dst;
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
 * authority — dispatch then refuses keyed streams).
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
): Promise<StreamDescriptor> {
  if (descriptor.protocol !== "hls" || descriptor.drm) return descriptor;

  const variant = pickVariant(descriptor, choice);
  if (!variant || variant.audioRenditionId === null) return descriptor;
  const rendition = pickAudioRendition(descriptor, variant, choice);
  if (!rendition) return descriptor;

  if (!needsMaterialization(variant) && !needsMaterialization(rendition)) return descriptor;

  onProgress(0, null, "fetching-playlist");
  const video = await materializeTrack(variant, signal);
  const audio = await materializeTrack(rendition, signal);

  return {
    ...descriptor,
    variants: descriptor.variants.map(v => (v.id === variant.id ? video : v)),
    audioRenditions: (descriptor.audioRenditions ?? []).map(r => (r.id === rendition.id ? audio : r)),
  };
}

// Mirrors dispatch's selection (explicit choice.variantId, else highest height
// then bitrate) so the engine materializes exactly the tracks dispatch picks.
// Must stay in sync with pickVariant in @savemedia/core engine/dispatch.ts.
function pickVariant(descriptor: StreamDescriptor, choice: UserChoice): Variant | null {
  if (descriptor.variants.length === 0) return null;
  if (choice.variantId) {
    for (const v of descriptor.variants) if (v.id === choice.variantId) return v;
  }
  const sorted = [...descriptor.variants].sort((a, b) => {
    const h = (b.height ?? 0) - (a.height ?? 0);
    if (h !== 0) return h;
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  });
  return sorted[0] ?? null;
}

// Mirrors dispatch's pickHlsAudioRendition: explicit choice overrides the
// variant's linked audio group.
function pickAudioRendition(
  descriptor: StreamDescriptor,
  variant: Variant,
  choice: UserChoice,
): Variant | null {
  const renditions = descriptor.audioRenditions ?? [];
  if (choice.audioRenditionId) {
    const chosen = renditions.find(r => r.audioRenditionId === choice.audioRenditionId);
    if (chosen) return chosen;
  }
  return renditions.find(r => r.audioRenditionId === variant.audioRenditionId) ?? null;
}

function needsMaterialization(v: Variant): boolean {
  return v.segmentRef.kind === "hls-segments" && v.segmentRef.segmentUrls.length === 0;
}

async function materializeTrack(v: Variant, signal: AbortSignal): Promise<Variant> {
  if (!needsMaterialization(v) || v.segmentRef.kind !== "hls-segments") return v;
  const playlistUrl = v.segmentRef.playlistUrl;
  const resp = await fetchWithRetry(playlistUrl, signal, "manifest").catch(err => {
    throw classifyNetworkFailure(err, "manifest", playlistUrl) ?? err;
  });
  const media = parseHlsMediaPlaylistRuntime(await resp.text(), playlistUrl);
  if (!media.isVod) {
    throw { code: "hls_live_unsupported", severity: "terminal", manifestUrl: playlistUrl };
  }
  return {
    ...v,
    estimatedSize: estimatedTrackBytes(v.bitrate, media.segments) ?? v.estimatedSize,
    segmentRef: {
      ...v.segmentRef,
      initSegmentUrl: media.initSegmentUrl,
      segmentUrls: media.segments.map(s => s.uri),
      encryption: toHlsEncryption(media.encryption),
    },
  };
}

/**
 * The master playlist carries BANDWIDTH but no duration, so a demuxed
 * variant reaches dispatch with `estimatedSize` null and the browser-output
 * size guard could never fire. The media playlist completes the estimate:
 * bits/s × summed segment duration (the DASH adapter's formula). EXT-X-MEDIA
 * renditions carry no BANDWIDTH and stay null; per RFC 8216 the variant's
 * BANDWIDTH already covers its audio group, so the combined estimate holds.
 */
function estimatedTrackBytes(
  bitrate: number | null,
  segments: readonly RuntimeSegment[],
): number | null {
  if (bitrate == null) return null;
  const durationSeconds = segments.reduce((total, s) => total + (s.duration || 0), 0);
  if (durationSeconds <= 0) return null;
  return Math.round((bitrate / 8) * durationSeconds);
}

function toHlsEncryption(enc: RuntimeEncryption | null): HlsEncryption | null {
  if (!enc) return null;
  const method = enc.method.toUpperCase();
  if (method === "NONE") return null;
  if (method === "AES-128" || method === "SAMPLE-AES" || method === "SAMPLE-AES-CTR") {
    return { method, keyUri: enc.keyUri, iv: enc.iv };
  }
  // A keyed method the descriptor type cannot carry — same terminal verdict
  // dispatch reaches for any non-AES-128 key method.
  throw { code: "cdm_required", severity: "terminal", keySystem: method };
}
