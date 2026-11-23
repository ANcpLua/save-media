import type { SiteResolver } from "./types";
import { twitterResolver } from "./twitter";
import { instagramResolver } from "./instagram";
import { youtubeResolver } from "./youtube";

/** Set by vite.config.ts: true in store packages (`bun run zip`). */
declare const __STORE_BUILD__: boolean;

// The Chrome Web Store does not accept extensions that save from the youtube
// reader's site, so store packages leave that reader out; builds made with
// `bun run build` keep it. A store package offers none of that site's media
// in the browser by another way either: its hosts stay in the background's
// managed-host list (background/network-capture.ts) in every build, which
// keeps network capture and the page bridge off its pages, and a store
// package makes no check of the addresses such a page declares or its players
// hold (onStoreExcludedSite, applied in background/index.ts). The opt-in
// Local downloader is not gated by site: it hands any page to the user's own
// yt-dlp, in store packages too (docs/boundary-rules.md, open owner decision).
export const SITE_RESOLVERS: readonly SiteResolver[] = __STORE_BUILD__
  ? [twitterResolver, instagramResolver]
  : [twitterResolver, instagramResolver, youtubeResolver];

/** The resolver authoritative for a page URL, or null for ordinary pages. */
export function resolverForPage(pageUrl: string): SiteResolver | null {
  let hostname: string;
  try {
    hostname = new URL(pageUrl).hostname;
  } catch {
    return null;
  }
  return SITE_RESOLVERS.find(resolver => resolver.ownsHost(hostname)) ?? null;
}
