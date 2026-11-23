// MAIN world, on the hosts that have a site resolver. The site's own API
// responses name its media files; the resolver reads them from the responses
// the page receives.
import { dedupeKey } from "../sites/json";
import type { ResolvedMedia, SiteResolver } from "../sites/types";
import type { ResponseWatcher } from "./observe-responses";

/** The media one API response yields. A changed body shape gives none, never an error. */
export function extractCaptures(resolver: SiteResolver, requestUrl: string, bodyText: string): readonly ResolvedMedia[] {
  if (!resolver.matchesApi(requestUrl)) return [];
  try { return resolver.parse(bodyText); } catch { return []; }
}

export function resolverWatcher(resolver: SiteResolver, emit: (url: string, audioUrl?: string) => void): ResponseWatcher {
  const emitted = new Set<string>();
  return {
    maxChars: 16 * 1024 * 1024,
    wants: url => resolver.matchesApi(url),
    read(url, body) {
      if (typeof body !== "string") return;
      for (const media of extractCaptures(resolver, url, body)) {
        // An empty audio half would turn a demuxed pair into a silent video: drop the capture.
        if (media.audioUrl !== undefined && !media.audioUrl) continue;
        // Signed addresses change on every response; the resolver's content identity does not.
        const key = media.dedupeKey ?? (media.audioUrl === undefined ? dedupeKey(media.url) : media.url);
        if (emitted.has(key)) continue;
        emitted.add(key);
        emit(media.url, media.audioUrl);
      }
    },
  };
}
