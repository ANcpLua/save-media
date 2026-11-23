// What the bridge forwards of a message the page's MAIN world posted. A page
// can post anything, so the bridge builds the forwarded message itself: only
// the fields below, each checked, and the page address taken from the
// document, never from the message. Hand-written on purpose: the bridge runs
// in every frame of every page and carries no schema library. The background
// validates the result again (types/messages.ts); a unit test keeps the two
// in agreement.

export const BRIDGE_TAG = "__savemedia" as const;
export const MAX_URL = 8192;
const MAX_AD_URLS = 100;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_URL && /^https?:\/\//i.test(value);
}

/** The capture message to forward for a posted value, or null when it is not one. */
export function mainPayload(value: unknown, pageUrl: string): Record<string, unknown> | null {
  if (!isRecord(value) || value[BRIDGE_TAG] !== true) return null;
  if (value.kind === "ad-media") {
    const urls = Array.isArray(value.adUrls) ? value.adUrls.filter(isAddress).slice(0, MAX_AD_URLS) : [];
    const via = value.adVia;
    if (!urls.length || (via !== "vast" && via !== "vmap" && via !== "hls-interstitial" && via !== "hls-asset-list")) return null;
    return { [BRIDGE_TAG]: true, kind: "ad-media", url: null, pageUrl, adUrls: urls, adVia: via };
  }
  if (value.kind !== "media-source" || !isAddress(value.url)) return null;
  if (value.audioUrl !== undefined && !isAddress(value.audioUrl)) return null;
  return { [BRIDGE_TAG]: true, kind: "media-source", url: value.url, pageUrl,
    ...(value.audioUrl === undefined ? {} : { audioUrl: value.audioUrl }) };
}
