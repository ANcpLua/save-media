import type { DiscoveredMedia } from "../types/messages";

/** Keep only successful public GETs made by this download document during link generation.
 * Some sites return signature fields for exactly one pathname. Renew those on the
 * transfer route so the signing and media servers see the same client address.
 */
export async function observeFileLink(
  tabId: number, documentUrl: string, generate: () => Promise<DiscoveredMedia | null>,
): Promise<DiscoveredMedia | null> {
  const origin = new URL(documentUrl).origin;
  const candidates = new Set<string>();
  const observe = (event: chrome.webRequest.OnHeadersReceivedDetails): undefined => {
    if (event.tabId !== tabId || event.initiator !== origin || event.method !== "GET"
      || event.statusCode !== 200 || candidates.size >= 32) return;
    const url = new URL(event.url);
    if (url.searchParams.size === 1 && url.searchParams.has("path")) candidates.add(url.href);
  };
  chrome.webRequest.onHeadersReceived.addListener(observe, { urls: ["https://*/*"], types: ["xmlhttprequest"] });
  try {
    const source = await generate();
    if (!source) return null;
    const {signatureRequest, ...media} = source;
    if (!signatureRequest || !candidates.has(signatureRequest)) return media;
    const path = new URL(source.url).pathname;
    return new URL(signatureRequest).searchParams.get("path") === path ? source : media;
  } finally {
    chrome.webRequest.onHeadersReceived.removeListener(observe);
  }
}
