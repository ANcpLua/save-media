// Site resolvers turn a site's own API-response JSON into concrete media
// URLs the rest of the pipeline already understands. They are pure: no DOM,
// no chrome.*, no network — so they unit-test against captured fixtures.
//
// Twitter/Instagram resolve *progressive* (muxed audio+video) MP4 only.
// YouTube serves video and audio demuxed (adaptive itags) and resolves to a
// URL pair the av-merge engine muxes into one MP4.

export type SiteId = "twitter" | "instagram" | "youtube";

export interface ResolvedMedia {
  /** Absolute URL of the media file (the video-only half when demuxed). */
  readonly url: string;
  readonly site: SiteId;
  readonly width: number | null;
  readonly height: number | null;
  readonly bitrate: number | null;
  /**
   * Companion audio-track URL when the site serves video and audio demuxed
   * (YouTube adaptive itags). Absent for progressive muxed media. When
   * present, `url` is video-only and the capture becomes an av-merge job.
   */
  readonly audioUrl?: string;
  /**
   * Stable content identity for media whose URL is freshly signed on every
   * API response (googlevideo `expire`/`sig`/`n`): re-fetching the player for
   * the SAME video yields a different `url`, so URL-based dedupe would
   * surface it as a new stream. When present, the content script dedupes on
   * this instead of the URL.
   */
  readonly dedupeKey?: string;
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
