import type { ResolvedMedia, SiteResolver } from "./types";
import { dedupeKey, isRecord, walkObjects } from "./json";

const OWNED_HOST = /(^|\.)instagram\.com$/i;

// Instagram's media metadata arrives over its GraphQL endpoint and the
// private `/api/v1/` REST surface (feed, reels, media info). Both carry a
// `video_versions` array on the media object.
const API_URL = /\/graphql|\/api\/v1\//i;

const MAX_MEDIA = 24;

interface BestVersion {
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * `video_versions` are progressive muxed MP4s, sorted best-first by IG. We
 * still pick by max width defensively. The adaptive/demuxed alternative,
 * `video_dash_manifest`, is intentionally ignored here — it needs the merge
 * engine — so IG videos exposed *only* as DASH stay unhandled until then.
 */
function bestVersion(versions: unknown): BestVersion | null {
  if (!Array.isArray(versions)) return null;
  let best: BestVersion | null = null;
  for (const entry of versions) {
    if (!isRecord(entry)) continue;
    if (typeof entry.url !== "string") continue;
    const width = typeof entry.width === "number" ? entry.width : null;
    const height = typeof entry.height === "number" ? entry.height : null;
    if (best === null || (width ?? 0) > (best.width ?? 0)) {
      best = { url: entry.url, width, height };
    }
  }
  return best;
}

export const instagramResolver: SiteResolver = {
  id: "instagram",
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
      const best = bestVersion(node.video_versions);
      if (best === null) return;
      const key = dedupeKey(best.url);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        url: best.url,
        site: "instagram",
        width: best.width,
        height: best.height,
        bitrate: null,
      });
    });
    return out;
  },
};
