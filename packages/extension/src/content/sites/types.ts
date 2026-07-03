// Site resolvers turn a site's own API-response JSON into concrete media
// URLs the rest of the pipeline already understands. They are pure: no DOM,
// no chrome.*, no network — so they unit-test against captured fixtures.
//
// PR A resolves *progressive* (muxed audio+video) MP4 only. Demuxed
// audio/video (Twitter HLS audio groups, Instagram DASH, YouTube adaptive)
// needs the merge engine and is handled separately.

export type SiteId = "twitter" | "instagram";

export interface ResolvedMedia {
  /** Absolute URL of a progressive, muxed media file. */
  readonly url: string;
  readonly site: SiteId;
  readonly width: number | null;
  readonly height: number | null;
  readonly bitrate: number | null;
}

export interface SiteResolver {
  readonly id: SiteId;
  /** True when this resolver is authoritative for the given page hostname. */
  ownsHost(hostname: string): boolean;
  /** True when a network response at this URL may carry resolvable media. */
  matchesApi(url: string): boolean;
  /** Parse an API response body into progressive media, best-first, deduped. */
  parse(bodyText: string): readonly ResolvedMedia[];
}
