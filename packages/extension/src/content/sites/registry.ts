import type { SiteResolver } from "./types";
import { twitterResolver } from "./twitter";
import { instagramResolver } from "./instagram";

export const SITE_RESOLVERS: readonly SiteResolver[] = [twitterResolver, instagramResolver];

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
