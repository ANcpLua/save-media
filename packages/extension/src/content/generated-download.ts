import { declaredMediaFilename } from "./discovery";
import type { DiscoveredMedia, FileDownloadOffer } from "../types/messages";

declare const __BROWSER__: "chromium" | "firefox";

type FileNavigation = Event & {
  readonly destination: { readonly url: string; readonly sameDocument: boolean };
  readonly navigationType: string;
  readonly formData: FormData | null;
  readonly sourceElement?: Element | null;
};

const browserNavigation = (window as Window & { readonly navigation?: EventTarget }).navigation;
let pending: Promise<DiscoveredMedia | null> | undefined;

function downloadControl(offscreen = false): { link: HTMLAnchorElement; offer: FileDownloadOffer } | null {
  const filename = declaredMediaFilename(document);
  if (!browserNavigation || !filename) return null;
  // Chromium may skip layout inside its offscreen document.
  const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(link =>
    /^download(?: file| video)?$/i.test((link.getAttribute("aria-label") || link.textContent || "").trim())
    && (offscreen || (link.getClientRects().length > 0 && getComputedStyle(link).visibility === "visible"))
    && !link.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]'));
  const candidates = links.flatMap(link => {
    const offer = downloadOffer(link, filename);
    return offer ? [{ link, offer }] : [];
  });
  if (candidates.length <= 1) return candidates[0] ?? null;
  // Related items can have their own Download links. Use the nearest
  // section shared by the file's heading and a single eligible control.
  const heading = [...document.querySelectorAll("h1")].find(item => item.textContent?.trim() === filename);
  for (let section = heading?.parentElement; section && section !== document.body; section = section.parentElement) {
    const inSection = candidates.filter(({ link }) => section?.contains(link));
    if (inSection.length) return inSection.length === 1 ? inSection[0]! : null;
  }
  return null;
}

function downloadOffer(link: HTMLAnchorElement, filename: string): FileDownloadOffer | null {
  if (link.getAttribute("href") === "#") return { filename };
  try {
    const url = new URL(link.getAttribute("href")!, document.baseURI);
    // A linked download page has a normal browser address on the same site.
    if (!isWebDestination(url) || url.hash || url.href === location.href || link.hasAttribute("download")
      || (url.origin !== location.origin && !url.hostname.endsWith(`.${location.hostname}`))) return null;
    return { filename, linkedPage: url.href };
  } catch {
    return null;
  }
}

function isWebDestination(url: URL): boolean {
  return !url.username && !url.password
    && (url.protocol === "https:" || (url.protocol === "http:" && url.origin === location.origin));
}

export function fileDownloadOffer(): FileDownloadOffer | undefined {
  if (window.top !== window) return undefined;
  const offer = downloadControl()?.offer;
  return offer?.linkedPage && __BROWSER__ !== "chromium" ? undefined : offer;
}

/** Observe the navigation that the site's own download handler requests. */
export function captureGeneratedDownload(expectedFilename: string, offscreen = false): Promise<DiscoveredMedia | null> {
  const control = downloadControl(offscreen);
  if (!control || control.offer.linkedPage || control.offer.filename !== expectedFilename) return Promise.resolve(null);
  const { link } = control;
  if (pending) return pending;
  const navigation = browserNavigation!;
  const pageUrl = location.href;
  pending = new Promise<DiscoveredMedia | null>(resolve => {
    const timeout = setTimeout(() => finish(null), 6_000);
    function finish(source: DiscoveredMedia | null): void {
      clearTimeout(timeout);
      navigation.removeEventListener("navigate", onNavigate);
      window.removeEventListener("pagehide", onPageHide);
      resolve(source);
    }
    function onPageHide(): void { finish(null); }
    function onNavigate(event: Event): void {
      if (!event.isTrusted || location.href !== pageUrl) return;
      const move = event as FileNavigation;
      if (move.destination.sameDocument || move.navigationType === "traverse"
        || (move.sourceElement && move.sourceElement !== link)) return;
      if (!event.cancelable) { finish(null); return; }
      const url = new URL(move.destination.url);
      // Let the existing verifier fetch the requested address. This also
      // keeps the site's default navigation from starting a second download.
      event.preventDefault();
      if (move.formData || !isWebDestination(url)) {
        finish(null);
        return;
      }
      // Correlate a pathname-specific renewal with this document's own fetch,
      // even when several sandboxed frames share a download origin.
      const requests = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const signers = new Set(requests.filter(request => {
        if (request.initiatorType !== "fetch" && request.initiatorType !== "xmlhttprequest") return false;
        const address = new URL(request.name, pageUrl);
        return address.protocol === "https:" && address.searchParams.size === 1
          && address.searchParams.get("path") === url.pathname;
      }).map(request => request.name));
      const [signatureRequest] = signers;
      finish({ url: url.href, filenameHint: expectedFilename,
        ...(signers.size === 1 && signatureRequest ? {signatureRequest} : {}) });
    }
    navigation.addEventListener("navigate", onNavigate);
    window.addEventListener("pagehide", onPageHide, { once: true });
    try { link.click(); } catch { finish(null); }
  }).finally(() => { pending = undefined; });
  return pending;
}

// The offscreen extension document hosts an explicitly selected download
// page in a sandbox. Only that parent can ask this frame to run its control.
window.addEventListener("message", event => {
  if (window.top === window || event.origin !== chrome.runtime.getURL("").slice(0, -1)
    || event.source !== window.parent) return;
  const request = event.data;
  if (request?.type !== "read-file-download" || typeof request.id !== "string"
    || typeof request.filename !== "string" || request.pageUrl !== location.href) return;
  void captureGeneratedDownload(request.filename, true).then(source => {
    chrome.runtime.sendMessage({ type: "file-download-url", id: request.id, source },
      () => void chrome.runtime.lastError);
  });
});
