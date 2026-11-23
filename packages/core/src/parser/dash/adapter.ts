import type { Variant, VariantId, AudioRenditionId, SegmentRef } from "../../types/codec";
import type { DrmStatus, Presentation } from "../../types/stream";
import { addressBudget, isoDurationSeconds } from "../limits";
import { parseMpdBounded } from "./bounded";
import { coveredFileEnd } from "../byte-ranges";
import { parseVideoCodec, parseAudioCodec } from "../../classifier/codec-registry";
import { classifyContentProtection, type ContentProtectionElement } from "./content-protection";

export interface DashParseResult {
  readonly videoVariants: readonly Variant[];
  readonly audioRenditions: readonly Variant[];
  readonly drm: DrmStatus;
  readonly presentation: Presentation;
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
 * mpd-parser. Scanning the raw text ensures we catch all schemeIdUri values, in either
 * XML quote style and with or without a namespace prefix.
 */
function collectContentProtectionFromXml(manifestXml: string): readonly ContentProtectionElement[] {
  const out: ContentProtectionElement[] = [];
  const cpRegex = /<(?:[\w.-]+:)?ContentProtection\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = cpRegex.exec(manifestXml)) !== null) {
    const attrs = m[1] ?? "";
    const schemeIdUri = attribute(attrs, "schemeIdUri");
    if (schemeIdUri) out.push({ schemeIdUri: schemeIdUri.toLowerCase(), value: attribute(attrs, "value") });
  }
  return out;
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(attrs);
  return match?.[2]?.trim() || null;
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

/** MPD@type, mediaPresentationDuration and the longest segment the manifest states. */
function dashPresentation(manifestXml: string, playlists: readonly (ParsedDashPlaylist | undefined)[]): Presentation {
  const root = /<(?:[\w.-]+:)?MPD\b([^>]*)>/.exec(manifestXml)?.[1] ?? "";
  const live = attribute(root, "type") === "dynamic";
  const stated = isoDurationSeconds(attribute(root, "maxSegmentDuration"));
  let longest = 0;
  for (const playlist of playlists) for (const segment of playlist?.segments ?? []) longest = Math.max(longest, segment.duration || 0);
  const duration = isoDurationSeconds(attribute(root, "mediaPresentationDuration"));
  return { live, durationSeconds: live ? null : duration, maxSegmentSeconds: stated ?? (longest > 0 ? longest : null) };
}

type ParsedDashPlaylist = {
  /** mpd-parser sets this true iff MPD@type is static (a missing type defaults to static). */
  readonly endList?: boolean;
  readonly segments?: readonly ParsedDashSegment[];
  /** Set for a SegmentBase with an index range: the file, and where its index and header lie in it. */
  readonly sidx?: ParsedDashSegment;
};

/** A representation kept in one file, and where the manifest says that file ends, when it says so. */
interface OneFile {
  readonly url: string;
  readonly bytes: number | null;
}

/**
 * A representation that is one file. Its BaseURL names the whole
 * representation, and byte ranges only say where a player finds the header,
 * the index and the segments inside that file, so it can ask for them piece
 * by piece. The file as a whole is the track, and it is returned here to be
 * read as one. mpd-parser gives such a representation in three shapes:
 *
 * - SegmentBase with an index range: an index reference with no segments.
 * - SegmentBase without one: one segment, the file, whose init section is a
 *   range of the same address.
 * - SegmentList of byte ranges: the init section from the file's first byte,
 *   then every segment as the range that follows the one before. The ranges
 *   then cover the file from its start to a stated end without a gap.
 *
 * Ranges that leave a gap, start elsewhere or lie in another file than their
 * init section do not say what the whole file is, and give null.
 */
function singleFile(playlist: ParsedDashPlaylist): OneFile | null {
  const segs = playlist.segments ?? [];
  const index = playlist.sidx;
  if (index && segs.length === 0) {
    return !index.map?.resolvedUri || index.map.resolvedUri === index.resolvedUri ? { url: index.resolvedUri, bytes: null } : null;
  }
  const first = segs[0];
  if (index || !first) return null;
  const header = first.map;
  if (segs.length === 1 && !first.byterange) {
    return header?.byterange && header.resolvedUri === first.resolvedUri ? { url: first.resolvedUri, bytes: null } : null;
  }
  if (header?.resolvedUri !== first.resolvedUri || !header.byterange) return null;
  for (const seg of segs) {
    if (seg.resolvedUri !== first.resolvedUri || seg.map?.resolvedUri !== header.resolvedUri) return null;
    if (seg.map.byterange?.offset !== header.byterange.offset || seg.map.byterange.length !== header.byterange.length) return null;
  }
  const end = coveredFileEnd([header.byterange, ...segs.map(seg => seg.byterange)]);
  return end === null ? null : { url: first.resolvedUri, bytes: end };
}

/**
 * Materialize mpd-parser's expanded segment list into a dash-segments ref:
 * every segment under its own address, or the one file of a representation
 * its manifest keeps in a single file (singleFile). Byte ranges that do not
 * add up to one file give no address to fetch one by one, and a dynamic
 * (live) MPD expands to only the current availability window: downloading
 * either would save a truncated file and report success. Both yield an empty
 * ref, which dispatch refuses.
 *
 * So does every track of a manifest of several periods (`onePeriod` false).
 * Each period is a presentation of its own, with its own header and its own
 * timeline, and one of them is often not the video at all (an ad placed
 * before it). mpd-parser hands the periods over either as separate tracks
 * under one name, or as one track whose segments run on under the first
 * period's header. Saving the first, or joining them under a header that is
 * not theirs, would save the wrong video or a broken one and report success.
 */
function dashSegmentRef(playlist: ParsedDashPlaylist | undefined, counted: (address: string) => string, onePeriod: boolean): SegmentRef {
  const segs = playlist?.segments ?? [];
  if (playlist?.endList !== true || !onePeriod) return { kind: "dash-segments", initUrl: "", mediaUrls: [] };
  const file = singleFile(playlist);
  if (file) return { kind: "dash-segments", initUrl: "", mediaUrls: [counted(file.url)], ...(file.bytes !== null ? { fileBytes: file.bytes } : {}) };
  if (segs.some(s => s.byterange || s.map?.byterange)) {
    return { kind: "dash-segments", initUrl: "", mediaUrls: [] };
  }
  return {
    kind: "dash-segments",
    initUrl: counted(segs[0]?.map?.resolvedUri ?? ""),
    mediaUrls: segs.map(s => counted(s.resolvedUri)),
  };
}

/** The stretches a size is estimated over: the segments, or the one indexed file of a SegmentBase representation. */
function timed(playlist: ParsedDashPlaylist | undefined): readonly ParsedDashSegment[] {
  const segs = playlist?.segments ?? [];
  return segs.length ? segs : playlist?.sidx ? [playlist.sidx] : [];
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

/**
 * Throws manifest_too_large, before anything is expanded, for a manifest that
 * declares too many segments or too much address text; the addresses that
 * were built are counted once more as they are, so the limit holds exactly.
 */
export function parseDash(manifestXml: string, manifestUrl: string): DashParseResult {
  const parsed = parseMpdBounded(manifestXml, manifestUrl);
  const counted = addressBudget(manifestUrl);

  const cpElements = collectContentProtectionFromXml(manifestXml);
  const { drm } = classifyContentProtection(cpElements);

  const videoVariants: Variant[] = [];
  const audioRenditions: Variant[] = [];
  const onePeriod = (manifestXml.match(/<(?:[\w.-]+:)?Period\b/g) ?? []).length === 1;
  // Two periods can name their representations alike. An id names one track: a later track of the same name gets a number.
  const taken = new Map<string, number>();
  const trackId = (id: string): VariantId => {
    const count = (taken.get(id) ?? 0) + 1;
    taken.set(id, count);
    return counted(count === 1 ? id : `${id}~${count}`) as VariantId;
  };

  for (const p of (parsed.playlists ?? [])) {
    const codecs = (p.attributes?.CODECS as string | undefined) ?? "";
    const [vCodec, aCodec] = splitCodecs(codecs);
    if (p.attributes?.RESOLUTION) {
      const bitrate = (p.attributes.BANDWIDTH as number | undefined) ?? null;
      videoVariants.push({
        id: trackId(`${manifestUrl}#${p.attributes?.NAME ?? videoVariants.length}`),
        width: p.attributes.RESOLUTION.width,
        height: p.attributes.RESOLUTION.height,
        frameRate: (p.attributes["FRAME-RATE"] as number | undefined) ?? null,
        bitrate,
        estimatedSize: estimateSizeBytes(bitrate, timed(p)),
        videoCodec: vCodec ? parseVideoCodec(vCodec) : null,
        audioCodec: aCodec ? parseAudioCodec(aCodec) : null,
        audioRenditionId: null,
        segmentRef: dashSegmentRef(p, counted, onePeriod),
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
        id: trackId(`${manifestUrl}#audio:${groupName}:${renditionName}`),
        width: null,
        height: null,
        frameRate: null,
        bitrate,
        estimatedSize: estimateSizeBytes(bitrate, timed(rendPlaylist)),
        videoCodec: null,
        audioCodec: codecsStr ? parseAudioCodec(codecsStr) : null,
        audioRenditionId: renditionName as AudioRenditionId,
        segmentRef: dashSegmentRef(rendPlaylist, counted, onePeriod),
      });
    }
  }

  const audioPlaylists = Object.values(parsed.mediaGroups?.AUDIO ?? {}).flatMap(group => Object.values(group).map(rendition => rendition.playlists?.[0]));
  return { videoVariants, audioRenditions, drm, presentation: dashPresentation(manifestXml, [...(parsed.playlists ?? []), ...audioPlaylists]) };
}
