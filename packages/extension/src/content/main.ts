// Content scripts in MV3 are injected as classic scripts — `import` is
// a syntax error. We intentionally duplicate this constant (also defined
// in src/types/messages.ts) so this file has no module dependencies and
// can ship as a standalone JS file.
//
// Keep the runtime code inside an IIFE. This script runs in the page's
// MAIN world; unscoped helper names can collide with page globals after
// minification and crash later async observers.
export {};
(() => {
const BRIDGE_TAG = "__savemedia" as const;

type CaptureKind = "media-element" | "media-source" | "eme" | "ms-probe";
interface PageCaptureMessage {
  [BRIDGE_TAG]: true;
  kind: CaptureKind;
  url: string | null;
  pageUrl: string;
  responseHeaders?: Readonly<Record<string, string>>;
  responseBodyHeadB64?: string;
  keySystem?: string;
  mimeType?: string;
  elementTag?: "video" | "audio";
  elementSrc?: string;
}

interface PageCommandMessage {
  [BRIDGE_TAG]: true;
  kind: "download-best-hotkey";
  pageUrl: string;
}

type MainToBridgeMessage = PageCaptureMessage | PageCommandMessage;
type CaptureExtras = Partial<Omit<PageCaptureMessage, typeof BRIDGE_TAG | "kind" | "url" | "pageUrl">>;

const post = (msg: MainToBridgeMessage): void => {
  window.postMessage(msg, "*");
};

/**
 * Canonicalise the captured URL against the page origin BEFORE posting.
 * The background service worker fetches this URL to classify it, and SW
 * fetch has no page-relative base — a bare "/hls/master.m3u8" would
 * resolve against `chrome-extension://<id>/` and 404. Resolving against
 * `location.href` here gives the SW an absolute URL that hits the
 * actual content origin.
 */
function canonicaliseUrl(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url, location.href).href; } catch { return url; }
}

const emit = (kind: CaptureKind, url: string | null, extras: CaptureExtras = {}): void => {
  post({ [BRIDGE_TAG]: true, kind, url: canonicaliseUrl(url), pageUrl: location.href, ...extras });
};

const emitDownloadBestHotkey = (): void => {
  post({ [BRIDGE_TAG]: true, kind: "download-best-hotkey", pageUrl: location.href });
};

/**
 * Resource timing gives us a passive page-side fallback for very early
 * manifest requests without monkey-patching fetch/XHR. The background
 * webRequest listener is the main discovery path; this catches entries
 * that raced ahead during extension startup.
 */
function looksLikeMediaEntry(url: string): boolean {
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) return true;
  if (looksLikeFragmentUrl(url)) return false;
  return /\.(mp4|webm|mkv)(\?|#|$)/i.test(url);
}

function looksLikeFragmentUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url, location.href).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const base = path.split("/").filter(Boolean).at(-1) ?? path;
  if (/\.(m4s|ts|mpegts)$/i.test(base)) return true;
  if (/\.mp4\/[^/]+\.(mp4|m4s)$/i.test(path)) return true;
  return /^(init|seg|segment|chunk|frag|fragment|part)(?:[._-][a-z0-9._-]*)?\.mp4$/i.test(base);
}

function observeResourceUrl(url: string): void {
  if (looksLikeMediaEntry(url)) emit("media-source", url);
}

try {
  performance.getEntriesByType("resource").forEach(entry => observeResourceUrl(entry.name));
  const observer = new PerformanceObserver(list => {
    list.getEntries().forEach(entry => observeResourceUrl(entry.name));
  });
  observer.observe({ type: "resource", buffered: true });
} catch {
  // Resource timing is best-effort; never perturb the page.
}

if (typeof MediaSource !== "undefined") {
  const _isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
  MediaSource.isTypeSupported = function (type: string) {
    if (/;\s*encrypted/i.test(type)) emit("ms-probe", null, { mimeType: type });
    return _isTypeSupported(type);
  };
}

if (navigator.requestMediaKeySystemAccess) {
  const _orig = navigator.requestMediaKeySystemAccess.bind(navigator);
  navigator.requestMediaKeySystemAccess = function (keySystem: string, config: MediaKeySystemConfiguration[]) {
    emit("eme", null, { keySystem });
    return _orig(keySystem, config);
  };
}

function observeMediaElement(el: HTMLVideoElement | HTMLAudioElement): void {
  const src = el.currentSrc || el.src || el.querySelector("source")?.src || null;
  if (src && !src.startsWith("blob:")) {
    emit("media-element", src, { elementTag: el.tagName.toLowerCase() as "video" | "audio", elementSrc: src });
  }
}

new MutationObserver(records => {
  for (const r of records) {
    r.addedNodes.forEach(n => {
      if (n instanceof HTMLVideoElement || n instanceof HTMLAudioElement) observeMediaElement(n);
      else if (n instanceof HTMLElement) {
        n.querySelectorAll("video, audio").forEach(el => observeMediaElement(el as HTMLVideoElement));
      }
    });
  }
}).observe(document.documentElement, { childList: true, subtree: true });

document.querySelectorAll("video, audio").forEach(el => observeMediaElement(el as HTMLVideoElement));

document.addEventListener("keydown", event => {
  if (!event.isTrusted || !isDownloadBestHotkey(event) || isEditableTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  emitDownloadBestHotkey();
}, true);

function isDownloadBestHotkey(event: KeyboardEvent): boolean {
  if (event.repeat || event.metaKey || event.shiftKey) return false;
  const sKey = event.code === "KeyS" || event.key.toLowerCase() === "s";
  if (!sKey) return false;
  return (event.altKey && !event.ctrlKey) || (event.ctrlKey && !event.altKey);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}
})();
