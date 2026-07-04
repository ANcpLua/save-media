import { parse as parseMpd } from "mpd-parser";
import type { Variant, VariantId, AudioRenditionId, SegmentRef } from "../../types/codec";
import type { DrmStatus } from "../../types/stream";
import { parseVideoCodec, parseAudioCodec } from "../../classifier/codec-registry";
import { classifyContentProtection, type ContentProtectionElement } from "./content-protection";

export interface DashParseResult {
  readonly videoVariants: readonly Variant[];
  readonly audioRenditions: readonly Variant[];
  readonly drm: DrmStatus;
}

function splitCodecs(codecs: string): [string | null, string | null] {
  if (!codecs) return [null, null];
  const parts = codecs.split(",").map(s => s.trim());
  const isVideo = (s: string) => /^(avc|hvc|hev|vp08|vp09|av01|mp4v)/i.test(s);
  const isAudio = (s: string) => /^(mp4a|opus|ac-3|ec-3|alac|vorbis|flac|mp3)/i.test(s);
  return [parts.find(isVideo) ?? null, parts.find(isAudio) ?? null];
}

/**
 * Extract ContentProtection elements directly from the raw MPD XML.
 *
 * mpd-parser only maps UUIDs in its own keySystemsMap (Widevine, PlayReady, ClearKey W3C, Adobe).
 * The DASH-IF ClearKey UUID (e2719d58) and any future unknown UUIDs are silently dropped by
 * mpd-parser. Scanning the raw text ensures we catch all schemeIdUri values.
 */
function collectContentProtectionFromXml(manifestXml: string): readonly ContentProtectionElement[] {
  const out: ContentProtectionElement[] = [];
  const cpRegex = /<ContentProtection\b([^>]*?)(?:\/>|>)/gi;
  let m: RegExpExecArray | null;
  while ((m = cpRegex.exec(manifestXml)) !== null) {
    const attrs = m[1] ?? "";
    const schemeIdUri = /schemeIdUri="([^"]+)"/i.exec(attrs)?.[1] ?? null;
    const value = /\bvalue="([^"]+)"/i.exec(attrs)?.[1] ?? null;
    if (schemeIdUri) {
      out.push({ schemeIdUri: schemeIdUri.toLowerCase(), value });
    }
  }
  return out;
}

type ParsedDashSegment = {
  readonly resolvedUri: string;
  readonly duration: number;
  readonly map?: {
    readonly resolvedUri?: string;
    readonly byterange?: { readonly length: number; readonly offset: number };
  };
  readonly byterange?: { readonly length: number; readonly offset: number };
};

type ParsedDashPlaylist = {
  /** mpd-parser sets this true iff MPD@type is static (a missing type defaults to static). */
  readonly endList?: boolean;
  readonly segments?: readonly ParsedDashSegment[];
};

/**
 * Materialize mpd-parser's expanded segment list into a dash-segments ref.
 * Byte-range addressed segments (SegmentBase/sidx) cannot be fetched as whole
 * URLs by the merge engine, and a dynamic (live) MPD expands to only the
 * current availability window — downloading it would save a truncated file
 * and report success. Both yield an empty ref and dispatch keeps refusing.
 */
function dashSegmentRef(playlist: ParsedDashPlaylist | undefined): SegmentRef {
  const segs = playlist?.segments ?? [];
  if (playlist?.endList !== true || segs.some(s => s.byterange || s.map?.byterange)) {
    return { kind: "dash-segments", initUrl: "", mediaUrls: [] };
  }
  return {
    kind: "dash-segments",
    initUrl: segs[0]?.map?.resolvedUri ?? "",
    mediaUrls: segs.map(s => s.resolvedUri),
  };
}

function estimateSizeBytes(
  bitrate: number | null,
  segments: readonly ParsedDashSegment[] | undefined,
): number | null {
  if (bitrate == null) return null;
  const durationSeconds = (segments ?? []).reduce((total, s) => total + (s.duration || 0), 0);
  if (durationSeconds <= 0) return null;
  return Math.round((bitrate / 8) * durationSeconds);
}

export function parseDash(manifestXml: string, manifestUrl: string): DashParseResult {
  const parsed = parseMpd(manifestXml, { manifestUri: manifestUrl });

  const cpElements = collectContentProtectionFromXml(manifestXml);
  const { drm } = classifyContentProtection(cpElements);

  const videoVariants: Variant[] = [];
  const audioRenditions: Variant[] = [];

  for (const p of (parsed.playlists ?? [])) {
    const codecs = (p.attributes?.CODECS as string | undefined) ?? "";
    const [vCodec, aCodec] = splitCodecs(codecs);
    if (p.attributes?.RESOLUTION) {
      const bitrate = (p.attributes.BANDWIDTH as number | undefined) ?? null;
      videoVariants.push({
        id: `${manifestUrl}#${p.attributes?.NAME ?? videoVariants.length}` as VariantId,
        width: p.attributes.RESOLUTION.width,
        height: p.attributes.RESOLUTION.height,
        frameRate: (p.attributes["FRAME-RATE"] as number | undefined) ?? null,
        bitrate,
        estimatedSize: estimateSizeBytes(bitrate, p.segments),
        videoCodec: vCodec ? parseVideoCodec(vCodec) : null,
        audioCodec: aCodec ? parseAudioCodec(aCodec) : null,
        audioRenditionId: null,
        segmentRef: dashSegmentRef(p),
      });
    }
  }

  for (const [groupName, group] of Object.entries(parsed.mediaGroups?.AUDIO ?? {})) {
    for (const [renditionName, rend] of Object.entries(group)) {
      // Audio rendition CODECS live on rend.playlists[0].attributes, not rend.attributes
      const rendPlaylist = rend.playlists?.[0];
      const rendPlaylistAttrs = rendPlaylist?.attributes;
      const codecsStr = (rendPlaylistAttrs?.CODECS as string | undefined) ?? "";
      const bitrate = (rendPlaylistAttrs?.BANDWIDTH as number | undefined) ?? null;
      audioRenditions.push({
        id: `${manifestUrl}#audio:${groupName}:${renditionName}` as VariantId,
        width: null,
        height: null,
        frameRate: null,
        bitrate,
        estimatedSize: estimateSizeBytes(bitrate, rendPlaylist?.segments),
        videoCodec: null,
        audioCodec: codecsStr ? parseAudioCodec(codecsStr) : null,
        audioRenditionId: renditionName as AudioRenditionId,
        segmentRef: dashSegmentRef(rendPlaylist),
      });
    }
  }

  return { videoVariants, audioRenditions, drm };
}
