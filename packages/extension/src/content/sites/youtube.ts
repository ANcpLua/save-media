import type { ResolvedMedia, SiteResolver } from "./types";
import { isRecord } from "./json";

// YouTube ships in unlisted/personal builds only (Chrome Web Store prohibits
// YouTube-download extensions); see the standing decision in .claude/TASK.md.
//
// Page hosts this resolver owns. NOT the media CDN (googlevideo.com).
const OWNED_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i;

// The watch page fetches all format metadata through the InnerTube player
// endpoint; one response fully describes one video.
const API_URL = /\/youtubei\/v1\/player/i;

// H.264 MP4 video itags, best-first (1080p → 360p). VP9/AV1 itags are
// deliberately excluded: merging those means WebM output — a later story.
const H264_VIDEO_ITAGS = [137, 136, 135, 134] as const;

// AAC-LC in an MP4 shell — the one audio itag every clear video carries.
const AAC_AUDIO_ITAG = 140;

interface AdaptiveFormat {
  readonly itag: number;
  readonly url: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly bitrate: number | null;
}

/**
 * Collect the directly-downloadable adaptive formats. Cipher-protected
 * entries carry `signatureCipher` and NO plain `url`; solving the cipher is
 * out of scope, so those formats are simply not downloadable here and are
 * skipped rather than crashed on.
 */
function adaptiveFormats(json: unknown): readonly AdaptiveFormat[] {
  if (!isRecord(json)) return [];
  const streamingData = json.streamingData;
  if (!isRecord(streamingData)) return [];
  const formats = streamingData.adaptiveFormats;
  if (!Array.isArray(formats)) return [];

  const out: AdaptiveFormat[] = [];
  for (const entry of formats) {
    if (!isRecord(entry)) continue;
    if (typeof entry.itag !== "number") continue;
    if (typeof entry.url !== "string") continue;
    if (typeof entry.mimeType !== "string") continue;
    out.push({
      itag: entry.itag,
      url: entry.url,
      mimeType: entry.mimeType,
      width: typeof entry.width === "number" ? entry.width : null,
      height: typeof entry.height === "number" ? entry.height : null,
      bitrate: typeof entry.bitrate === "number" ? entry.bitrate : null,
    });
  }
  return out;
}

function bestH264Video(formats: readonly AdaptiveFormat[]): AdaptiveFormat | null {
  for (const itag of H264_VIDEO_ITAGS) {
    const match = formats.find(f => f.itag === itag && /^video\/mp4;.*avc1/i.test(f.mimeType));
    if (match) return match;
  }
  return null;
}

function aacAudio(formats: readonly AdaptiveFormat[]): AdaptiveFormat | null {
  return formats.find(f => f.itag === AAC_AUDIO_ITAG && /^audio\/mp4/i.test(f.mimeType)) ?? null;
}

function videoId(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const details = json.videoDetails;
  if (!isRecord(details)) return null;
  return typeof details.videoId === "string" && details.videoId !== "" ? details.videoId : null;
}

export const youtubeResolver: SiteResolver = {
  id: "youtube",
  ownsHost: hostname => OWNED_HOST.test(hostname),
  matchesApi: url => API_URL.test(url),
  parse(bodyText) {
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return [];
    }

    const formats = adaptiveFormats(json);
    const video = bestH264Video(formats);
    const audio = aacAudio(formats);
    // Both halves or nothing: a lone video itag would download silent, and a
    // lone audio itag is not what "download this video" means.
    if (video === null || audio === null) return [];

    // The signed videoplayback URLs are re-minted (expire/sig/n) on every
    // player re-fetch of the same video; video id + itags are the stable
    // identity. Without a videoId the key is omitted and the content script
    // falls back to URL-based dedupe.
    const id = videoId(json);
    const media: ResolvedMedia = {
      url: video.url,
      site: "youtube",
      width: video.width,
      height: video.height,
      bitrate: video.bitrate,
      audioUrl: audio.url,
      ...(id === null ? {} : { dedupeKey: `youtube:${id}:${video.itag}+${audio.itag}` }),
    };
    return [media];
  },
};
