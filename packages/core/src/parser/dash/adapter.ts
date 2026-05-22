import { parse as parseMpd } from "mpd-parser";
import type { Variant, VariantId, AudioRenditionId } from "../../types/codec";
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
      videoVariants.push({
        id: `${manifestUrl}#${p.attributes?.NAME ?? videoVariants.length}` as VariantId,
        width: p.attributes.RESOLUTION.width,
        height: p.attributes.RESOLUTION.height,
        frameRate: (p.attributes["FRAME-RATE"] as number | undefined) ?? null,
        bitrate: (p.attributes.BANDWIDTH as number | undefined) ?? null,
        estimatedSize: null,
        videoCodec: vCodec ? parseVideoCodec(vCodec) : null,
        audioCodec: aCodec ? parseAudioCodec(aCodec) : null,
        audioRenditionId: null,
        segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] },
      });
    }
  }

  for (const [groupName, group] of Object.entries(parsed.mediaGroups?.AUDIO ?? {})) {
    for (const [renditionName, rend] of Object.entries(group)) {
      // Audio rendition CODECS live on rend.playlists[0].attributes, not rend.attributes
      const rendPlaylistAttrs = rend.playlists?.[0]?.attributes;
      const codecsStr = (rendPlaylistAttrs?.CODECS as string | undefined) ?? "";
      audioRenditions.push({
        id: `${manifestUrl}#audio:${groupName}:${renditionName}` as VariantId,
        width: null,
        height: null,
        frameRate: null,
        bitrate: (rendPlaylistAttrs?.BANDWIDTH as number | undefined) ?? null,
        estimatedSize: null,
        videoCodec: null,
        audioCodec: codecsStr ? parseAudioCodec(codecsStr) : null,
        audioRenditionId: renditionName as AudioRenditionId,
        segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] },
      });
    }
  }

  return { videoVariants, audioRenditions, drm };
}
