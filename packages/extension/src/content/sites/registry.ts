import type { SiteResolver } from "./types";
import { twitterResolver } from "./twitter";
import { instagramResolver } from "./instagram";
import { youtubeResolver } from "./youtube";

// youtube: unlisted/personal builds only (store policy — see .claude/TASK.md
// standing decision). The build exposes no flag reachable from content code
// yet, so the resolver registers unconditionally; the listing/unlisted split
// is enforced by not publishing builds that include it.
export const SITE_RESOLVERS: readonly SiteResolver[] = [twitterResolver, instagramResolver, youtubeResolver];

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
