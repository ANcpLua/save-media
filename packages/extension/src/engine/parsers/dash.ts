import { parse as parseMpd, type ParsedPlaylist } from "mpd-parser";

/**
 * Runtime DASH MPD parser. The core package classifies the manifest to a
 * StreamDescriptor at detection time; the engine re-fetches and re-parses
 * the MPD at job time to extract the concrete init + media segment URLs
 * for the chosen variant.
 */

export interface DashTrack {
  readonly initUrl: string;
  readonly mediaUrls: readonly string[];
}

export interface DashJobInputs {
  readonly video: DashTrack;
  readonly audio: DashTrack | null;
}

function pickVideoPlaylist(
  parsed: ReturnType<typeof parseMpd>,
  variantId: string | null,
): ParsedPlaylist | null {
  const playlists = parsed.playlists ?? [];
  if (variantId) {
    for (const p of playlists) {
      if (p.uri && variantId.endsWith(p.uri)) return p;
      if (p.attributes?.NAME && variantId.includes(String(p.attributes.NAME))) return p;
    }
  }
  // Highest-resolution + bandwidth fallback.
  const sorted = [...playlists].sort((a, b) => {
    const ha = a.attributes?.RESOLUTION?.height ?? 0;
    const hb = b.attributes?.RESOLUTION?.height ?? 0;
    if (hb !== ha) return hb - ha;
    return (b.attributes?.BANDWIDTH ?? 0) - (a.attributes?.BANDWIDTH ?? 0);
  });
  return sorted[0] ?? null;
}

function pickAudioPlaylist(
  parsed: ReturnType<typeof parseMpd>,
  renditionId: string | null,
): ParsedPlaylist | null {
  const groups = parsed.mediaGroups?.AUDIO;
  if (!groups) return null;
  for (const [_groupName, group] of Object.entries(groups)) {
    for (const [renditionName, rend] of Object.entries(group)) {
      const playlist = rend.playlists?.[0];
      if (!playlist) continue;
      if (renditionId && renditionId.endsWith(renditionName)) return playlist;
    }
  }
  // First available rendition.
  for (const group of Object.values(groups)) {
    for (const rend of Object.values(group)) {
      const playlist = rend.playlists?.[0];
      if (playlist) return playlist;
    }
  }
  return null;
}

function toTrack(playlist: ParsedPlaylist | null): DashTrack | null {
  if (!playlist) return null;
  const initUrl = playlist.segments?.[0]?.map?.uri ?? "";
  const mediaUrls = (playlist.segments ?? []).map(s => s.uri);
  if (!initUrl || mediaUrls.length === 0) return null;
  return { initUrl, mediaUrls };
}

export function parseDashJobInputs(
  manifestXml: string,
  manifestUrl: string,
  variantId: string | null,
  audioRenditionId: string | null,
): DashJobInputs | null {
  const parsed = parseMpd(manifestXml, { manifestUri: manifestUrl });
  const videoTrack = toTrack(pickVideoPlaylist(parsed, variantId));
  if (!videoTrack) return null;
  return { video: videoTrack, audio: toTrack(pickAudioPlaylist(parsed, audioRenditionId)) };
}
