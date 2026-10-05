import { MAIN_BRIDGE_TAG, type BridgeToBackgroundMessage } from "../types/messages";

export type CaptureHandler = (
  tabId: number,
  msg: Extract<BridgeToBackgroundMessage, { type: "capture" }>,
) => Promise<void>;

interface RequestDetails {
  readonly tabId: number;
  readonly url: string;
  readonly type?: string | undefined;
  readonly documentUrl?: string | undefined;
  readonly initiator?: string | undefined;
}

/**
 * Network request discovery lives in the extension process instead of
 * monkey-patching page fetch/XHR. That keeps page failures attributed to
 * the page and still catches manifest/direct-media entry requests.
 */
export function registerNetworkCapture(handleCapture: CaptureHandler): void {
  if (!chrome.webRequest?.onBeforeRequest) return;

  chrome.webRequest.onBeforeRequest.addListener(
    details => {
      void handleNetworkRequest(details, handleCapture);
    },
    { urls: ["<all_urls>"] },
  );
}

export function looksLikeMediaEntryUrl(url: string, requestType?: string): boolean {
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) return true;
  if (looksLikeFragmentUrl(url)) return false;
  if (requestType === "xmlhttprequest") return false;
  return /\.(mp4|webm|mkv)(\?|#|$)/i.test(url);
}

// Hosts where a dedicated MAIN-world site resolver (content/sites/*) is the
// authoritative source of the download URL(s). Generic webRequest sniffing
// on these pages only surfaces demuxed video-only noise that would outrank the
// real download, so we suppress it here. Deliberate mirror of the resolver
// `ownsHost` patterns — the two live on opposite sides of the content/background
// boundary and cannot share a module without breaking the classic-script bundle.
// googlevideo.com is the youtube media CDN, never a resolver page host, but
// `pageUrlFor` falls back to the request URL itself for CDN fetches with no
// page context — those must not enter generic discovery either.
const EXTRACTOR_MANAGED_HOST =
  /(^|\.)(twitter\.com|x\.com|instagram\.com|youtube\.com|youtube-nocookie\.com|googlevideo\.com)$/i;

export function isExtractorManagedHost(pageUrl: string): boolean {
  try {
    return EXTRACTOR_MANAGED_HOST.test(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

export function looksLikeFragmentUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const base = path.split("/").filter(Boolean).at(-1) ?? path;
  if (/\.(m4s|ts|mpegts)$/i.test(base)) return true;
  if (/\.mp4\/[^/]+\.(mp4|m4s)$/i.test(path)) return true;
  return /^(init|seg|segment|chunk|frag|fragment|part)(?:[._-][a-z0-9._-]*)?\.mp4$/i.test(base);
}

export interface SessionRulesApi {
  updateSessionRules(options: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void>;
}

/**
 * Hotlink-protected media hosts answer 403 without a Referer, and the
 * extension's own probe and download requests send none. One session rule
 * per media host gives requests from no tab (service worker, offscreen
 * document) initiated by this extension the page origin as Referer: what the
 * browser itself sends cross-origin under the default referrer policy (G2).
 * Keyed by host so playlist segments next to a manifest are covered, and kept
 * for the browser session so a running download never loses it.
 */
export function createRefererMirror(api: SessionRulesApi, extensionHost: string) {
  const current = new Map<string, string>();
  return async (url: string, pageUrl: string): Promise<void> => {
    let host: string;
    let referer: string;
    try {
      host = new URL(url).hostname;
      const page = new URL(pageUrl);
      if (page.protocol !== "https:" && page.protocol !== "http:") return;
      referer = `${page.origin}/`;
    } catch {
      return;
    }
    if (!host || current.get(host) === referer) return;
    current.set(host, referer);
    const id = ruleIdForHost(host);
    try {
      await api.updateSessionRules({
        removeRuleIds: [id],
        addRules: [{
          id,
          action: {
            type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [{
              header: "referer",
              operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
              value: referer,
            }],
          },
          // -1 is TAB_ID_NONE: the page's own requests keep their Referer.
          condition: { requestDomains: [host], initiatorDomains: [extensionHost], tabIds: [-1] },
        }],
      });
    } catch {
      current.delete(host);
    }
  };
}

/** FNV-1a: a stable id per host, so a restarted service worker replaces its own rule. */
function ruleIdForHost(host: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < host.length; i++) hash = Math.imul(hash ^ host.charCodeAt(i), 0x01000193);
  return (hash >>> 1) || 1;
}

async function handleNetworkRequest(
  details: RequestDetails,
  handleCapture: CaptureHandler,
): Promise<void> {
  if (details.tabId < 0 || !looksLikeMediaEntryUrl(details.url, details.type)) return;

  const pageUrl = await pageUrlFor(details);
  // A site resolver owns discovery on this page; skip the generic path.
  if (isExtractorManagedHost(pageUrl)) return;
  await handleCapture(details.tabId, {
    type: "capture",
    payload: {
      [MAIN_BRIDGE_TAG]: true,
      kind: "media-source",
      url: details.url,
      pageUrl,
    },
  });
}

async function pageUrlFor(details: RequestDetails): Promise<string> {
  if (details.documentUrl) return details.documentUrl;
  if (details.initiator && /^https?:\/\//i.test(details.initiator)) return details.initiator;
  try {
    const tab = await chrome.tabs.get(details.tabId);
    if (tab.url) return tab.url;
  } catch {
    // Tab may have gone away between the request and our async lookup.
  }
  return details.url;
}
