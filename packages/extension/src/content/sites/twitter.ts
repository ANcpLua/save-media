import type { ResolvedMedia, SiteResolver } from "./types";
import { dedupeKey, dimensionsFromUrl, isRecord, walkObjects } from "./json";

// Page hosts this resolver owns (used to gate generic discovery off and to
// pick this resolver for the page). NOT the media CDN (video.twimg.com).
const OWNED_HOST = /(^|\.)(twitter\.com|x\.com)$/i;

// Twitter serves each video's variants inside its GraphQL responses, whose
// URLs all contain `/graphql/`. We match broadly and let `parse` scan the
// body — enumerating operation names (TweetDetail, TweetResultByRestId,
// UserTweets, HomeTimeline, ...) would rot on the next client change.
const API_URL = /\/graphql\//i;

const MAX_MEDIA = 24;

interface BestVariant {
  readonly url: string;
  readonly bitrate: number | null;
}

/**
 * Pick the highest-bitrate progressive MP4 from a `video_info.variants`
 * array. `content_type: "video/mp4"` entries are muxed (audio+video) files;
 * the `application/x-mpegURL` entry is the demuxed HLS master we cannot mux
 * yet, so it is deliberately ignored here.
 */
function bestProgressiveVariant(variants: unknown): BestVariant | null {
  if (!Array.isArray(variants)) return null;
  let best: BestVariant | null = null;
  for (const entry of variants) {
    if (!isRecord(entry)) continue;
    if (entry.content_type !== "video/mp4") continue;
    if (typeof entry.url !== "string") continue;
    const bitrate = typeof entry.bitrate === "number" ? entry.bitrate : 0;
    if (best === null || bitrate > (best.bitrate ?? 0)) {
      best = { url: entry.url, bitrate: bitrate === 0 ? null : bitrate };
    }
  }
  return best;
}

export const twitterResolver: SiteResolver = {
  id: "twitter",
  ownsHost: hostname => OWNED_HOST.test(hostname),
  matchesApi: url => API_URL.test(url),
  parse(bodyText) {
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      return [];
    }

    const out: ResolvedMedia[] = [];
    const seen = new Set<string>();
    walkObjects(json, node => {
      if (out.length >= MAX_MEDIA) return;
      const info = node.video_info;
      if (!isRecord(info)) return;
      const best = bestProgressiveVariant(info.variants);
      if (best === null) return;
      const key = dedupeKey(best.url);
      if (seen.has(key)) return;
      seen.add(key);
      const dims = dimensionsFromUrl(best.url);
      out.push({
        url: best.url,
        site: "twitter",
        width: dims.width,
        height: dims.height,
        bitrate: best.bitrate,
      });
    });
    return out;
  },
};
