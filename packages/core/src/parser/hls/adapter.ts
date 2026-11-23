import { Parser } from "m3u8-parser";
import type { Variant, VariantId, AudioRenditionId } from "../../types/codec";
import { parseVideoCodec, parseAudioCodec } from "../../classifier/codec-registry";
import { parseHlsKeyDeclarations, parseHlsSessionKeys, type HlsKeyDeclaration } from "./keys";
import { addressBudget } from "../limits";

export interface HlsMasterParseResult {
  readonly variants: readonly Variant[];
  /**
   * URI-bearing EXT-X-MEDIA TYPE=AUDIO renditions as audio-only variants.
   * Segment URLs are not materialized here — only the rendition playlist URL
   * (segmentRef.playlistUrl); see StreamDescriptor.audioRenditions.
   */
  readonly audioRenditions: readonly Variant[];
  /** Every EXT-X-SESSION-KEY, judged by the same key policy as EXT-X-KEY. */
  readonly sessionKeys: readonly HlsKeyDeclaration[];
}

export interface HlsMediaPlaylistParseResult {
  readonly segments: ReadonlyArray<{ readonly uri: string; readonly duration: number }>;
  readonly initSegmentUrl: string | null;
  readonly isVod: boolean;
  /** EXT-X-TARGETDURATION in seconds, when stated. */
  readonly targetDuration: number | null;
  /**
   * Every EXT-X-KEY, read from the text: m3u8-parser drops KEYFORMAT, and
   * KEYFORMAT separates a key served in the clear from one a CDM holds.
   */
  readonly keyDeclarations: readonly HlsKeyDeclaration[];
}

function splitCodecs(codecs: string): [string | null, string | null] {
  if (!codecs) return [null, null];
  const parts = codecs.split(",").map(s => s.trim());
  const isVideo = (s: string) => /^(avc|hvc|hev|vp08|vp09|av01|mp4v)/i.test(s);
  const isAudio = (s: string) => /^(mp4a|opus|ac-3|ec-3|alac|vorbis|flac|mp3)/i.test(s);
  const v = parts.find(isVideo) ?? null;
  const a = parts.find(isAudio) ?? null;
  return [v, a];
}

function parseAudioGroups(
  mediaGroupsAudio: NonNullable<Parser["manifest"]["mediaGroups"]>["AUDIO"],
  manifestUrl: string,
  counted: (address: string) => string,
): { renditions: readonly Variant[]; chosenByGroup: ReadonlyMap<string, AudioRenditionId> } {
  const renditions: Variant[] = [];
  const chosenByGroup = new Map<string, AudioRenditionId>();

  for (const [groupId, group] of Object.entries(mediaGroupsAudio ?? {})) {
    const entries = Object.entries(group);
    // The rendition a player starts with: the one marked DEFAULT, else the first one listed.
    const played = entries.find(([, rend]) => rend.default === true) ?? entries[0];
    for (const [name, rend] of entries) {
      // No URI = this rendition's audio is muxed into the variant stream itself.
      if (!rend.uri) continue;
      renditions.push({
        id: counted(`${manifestUrl}#audio:${groupId}:${name}`) as VariantId,
        width: null,
        height: null,
        frameRate: null,
        bitrate: null,
        estimatedSize: null,
        videoCodec: null,
        // EXT-X-MEDIA carries no CODECS; the linked variant's split CODECS
        // already names the audio codec.
        audioCodec: null,
        audioRenditionId: `${groupId}:${name}` as AudioRenditionId,
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: counted(new URL(rend.uri, manifestUrl).href),
          initSegmentUrl: null,
          segmentUrls: [],
          encryption: null,
        },
      });
    }
    // A variant is linked to a rendition only when that is the audio the player plays. When the played
    // rendition has no URI, its audio is in the variant's own stream, and the variant is saved as it plays:
    // linking it to another language would replace the audio the viewer hears.
    if (played?.[1].uri) chosenByGroup.set(groupId, `${groupId}:${played[0]}` as AudioRenditionId);
  }

  return { renditions, chosenByGroup };
}

/** Throws manifest_too_large when the variant and rendition addresses resolve to more text than a manifest may hold. */
export function parseHlsMaster(manifestText: string, manifestUrl: string): HlsMasterParseResult {
  const parser = new Parser();
  parser.push(manifestText);
  parser.end();

  const manifest = parser.manifest;
  // Every variant's id repeats the manifest's address, and every relative name is joined to it.
  const counted = addressBudget(manifestUrl);
  const { renditions: audioRenditions, chosenByGroup } =
    parseAudioGroups(manifest.mediaGroups?.AUDIO, manifestUrl, counted);
  const variants: Variant[] = [];

  for (let i = 0; i < (manifest.playlists ?? []).length; i++) {
    const p = (manifest.playlists ?? [])[i];
    if (!p) continue;
    const codecsAttr: string = p.attributes?.CODECS ?? "";
    const [vCodecStr, aCodecStr] = splitCodecs(codecsAttr);
    const audioGroup = p.attributes?.AUDIO;

    variants.push({
      id: counted(`${manifestUrl}#var${i}`) as VariantId,
      width: p.attributes?.RESOLUTION?.width ?? null,
      height: p.attributes?.RESOLUTION?.height ?? null,
      frameRate: p.attributes?.["FRAME-RATE"] ?? null,
      bitrate: p.attributes?.BANDWIDTH ?? null,
      estimatedSize: null,
      videoCodec: vCodecStr ? parseVideoCodec(vCodecStr) : null,
      audioCodec: aCodecStr ? parseAudioCodec(aCodecStr) : null,
      audioRenditionId: audioGroup ? chosenByGroup.get(audioGroup) ?? null : null,
      segmentRef: {
        kind: "hls-segments",
        playlistUrl: counted(new URL(p.uri, manifestUrl).href),
        initSegmentUrl: null,
        segmentUrls: [],
        encryption: null,
      },
    });
  }

  return { variants, audioRenditions, sessionKeys: parseHlsSessionKeys(manifestText, manifestUrl) };
}

/** Throws manifest_too_large when the segment addresses resolve to more text than a manifest may hold. */
export function parseHlsMediaPlaylist(manifestText: string, manifestUrl: string): HlsMediaPlaylistParseResult {
  const parser = new Parser();
  parser.push(manifestText);
  parser.end();

  const manifest = parser.manifest;
  const segs = manifest.segments ?? [];
  const firstMap = segs.find(s => s.map?.uri)?.map ?? null;
  const counted = addressBudget(manifestUrl);
  return {
    initSegmentUrl: firstMap?.uri ? new URL(firstMap.uri, manifestUrl).href : null,
    isVod: manifest.endList === true,
    targetDuration: typeof manifest.targetDuration === "number" && manifest.targetDuration > 0 ? manifest.targetDuration : null,
    segments: segs.map(s => ({ uri: counted(new URL(s.uri, manifestUrl).href), duration: s.duration })),
    keyDeclarations: parseHlsKeyDeclarations(manifestText, manifestUrl),
  };
}
