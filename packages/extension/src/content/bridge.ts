// Vite inlines discovery into this classic content-script entry. Keep the
// message guards local so the bridge does not pull in the zod runtime.
import { declaredMediaFilename, discoverPageMedia } from "./discovery";
import { captureGeneratedDownload, fileDownloadOffer } from "./generated-download";
import type { DiscoveredMedia, FileSaveProblem, HotkeyFeedbackOutcome, PageMediaSnapshot } from "../types/messages";

export {};
const BRIDGE_TAG = "__savemedia" as const;
const CAPTURE_KINDS = ["media-element", "media-source", "eme", "ms-probe"] as const;

type CaptureKind = typeof CAPTURE_KINDS[number];

interface PageCapturePayload {
  [BRIDGE_TAG]: true;
  kind: CaptureKind;
  url: string | null;
  pageUrl: string;
  [key: string]: unknown;
}

interface DiscoverPageMediaMessage {
  type: "discover-page-media";
}

interface HotkeyFeedbackMessage {
  type: "hotkey-feedback";
  outcome: HotkeyFeedbackOutcome;
  detail: string;
}

// The page keeps the last attempt across popup closure and service worker sleep.
let lastFileSave: { pageUrl: string; problem: FileSaveProblem } | null = null;

window.addEventListener("message", event => {
  if (event.source !== window) return;
  const data = event.data;
  if (!isMainPayload(data)) return;
  chrome.runtime.sendMessage(
    { type: "capture", payload: withFilePageMetadata(data) },
    () => void chrome.runtime.lastError,
  );
});

// Keep the trusted keyboard gesture in the isolated bridge. A page's own
// postMessage cannot request a save or run its download control.
window.addEventListener("keydown", event => {
  if (!event.isTrusted || event.repeat || event.metaKey || event.shiftKey) return;
  if (event.altKey === event.ctrlKey || (event.code !== "KeyS" && event.key.toLowerCase() !== "s")) return;
  if (event.target instanceof HTMLElement && (event.target.isContentEditable
    || event.target.matches("input, textarea, select"))) return;
  event.preventDefault();
  event.stopPropagation();
  chrome.runtime.sendMessage({ type: "download-best-hotkey", pageUrl: location.href },
    () => void chrome.runtime.lastError);
}, true);

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (isHotkeyFeedbackMessage(msg)) {
    if (window.top === window) showToast(msg.outcome, msg.detail);
    return false;
  }
  if (isRecord(msg) && msg.type === "page-media-snapshot") {
    sendResponse(pageMediaSnapshot());
    return false;
  }
  if (isRecord(msg) && msg.type === "file-save-problem" && msg.pageUrl === location.href && window.top === window) {
    lastFileSave = msg.problem ? { pageUrl: location.href, problem: msg.problem as FileSaveProblem } : null;
    sendResponse({ ok: true });
    return false;
  }
  if (isRecord(msg) && msg.type === "generate-download-url" && typeof msg.filename === "string"
    && msg.pageUrl === location.href && window.top === window) {
    void captureGeneratedDownload(msg.filename).then(sendResponse);
    return true;
  }
  if (!isDiscoverPageMediaMessage(msg)) return false;
  const pageUrl = location.href;
  const media = discoverPageMedia(document, pageUrl);
  const offer = fileDownloadOffer();
  const reply = (items: readonly DiscoveredMedia[]) => sendResponse(location.href === pageUrl ? {
    pageUrl, urls: items.map(item => item.url), media: items,
    ...(offer ? { fileDownload: offer } : {}),
  } : null);
  if (media.length || offer || !declaredMediaFilename(document)) {
    reply(media);
    return false;
  }
  // A single-file page can add its player after an asynchronous request.
  // Allow that normal page work to finish before an early popup or hotkey
  // concludes there is no media. Other pages keep the immediate response.
  void waitForFilePageMedia(pageUrl).then(reply);
  return true;
});

function withFilePageMetadata(payload: PageCapturePayload): PageCapturePayload {
  if (payload.kind !== "media-element" || payload.elementTag !== "video" || !declaredMediaFilename(document)) return payload;
  const [media] = discoverPageMedia(document, location.href);
  if (!media?.filenameHint || media.url !== payload.url) return payload;
  return { ...payload, filenameHint: media.filenameHint, quality: media.quality };
}

function waitForFilePageMedia(pageUrl: string): Promise<readonly DiscoveredMedia[]> {
  return new Promise(resolve => {
    function finish(media: readonly DiscoveredMedia[]): void {
      observer.disconnect();
      clearTimeout(deadline);
      resolve(media);
    }
    const observer = new MutationObserver(() => {
      if (location.href !== pageUrl) { finish([]); return; }
      if (!document.querySelector("video[src], video source[src]")) return;
      const media = discoverPageMedia(document, pageUrl);
      if (media.length) finish(media);
    });
    const deadline = setTimeout(() => finish(location.href === pageUrl ? discoverPageMedia(document, pageUrl) : []), 4_000);
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  });
}

// Snapshot of the page's <video> elements for the popup: which one is
// playing, how big it is, and a small frame so the user can tell entries
// apart. Frames of cross-origin media taint the canvas; then the poster is
// used, followed by page metadata when there is just one video.
const THUMB_WIDTH = 160;

function pageMediaSnapshot(): PageMediaSnapshot {
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() || document.title;
  const elements = [...document.querySelectorAll("video")];
  const pageImage = elements.length === 1
    ? document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.getAttribute("content")?.trim()
    : null;
  const videos = elements.map(v => ({
    src: v.currentSrc || v.src || v.querySelector("source")?.src || "",
    thumbnail: captureFrame(v) ?? (v.poster ? absolute(v.poster) : pageImage ? absolute(pageImage) : null),
    width: v.videoWidth || Math.round(v.getBoundingClientRect().width),
    height: v.videoHeight || Math.round(v.getBoundingClientRect().height),
    duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
    visible: visibleFraction(v),
    playing: !v.paused && !v.ended && v.readyState >= 2,
  })).filter(v => v.src || v.thumbnail);
  const generated = fileDownloadOffer()?.filename;
  const problem = lastFileSave?.pageUrl === location.href ? lastFileSave.problem : null;
  return { pageTitle: title, videos, ...(generated ? { generatedDownloadFilename: generated } : {}),
    ...(problem ? { fileSaveProblem: problem } : {}) };
}

function captureFrame(v: HTMLVideoElement): string | null {
  if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.max(1, Math.round(THUMB_WIDTH * v.videoHeight / v.videoWidth));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch {
    return null;
  }
}

function visibleFraction(el: Element): number {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return 0;
  const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
  return (w * h) / (r.width * r.height);
}

function absolute(url: string): string {
  try { return new URL(url, location.href).href; } catch { return url; }
}

// In-page feedback for Alt+S. The popup is closed when the hotkey fires and
// the action badge is easy to miss, so the page itself confirms what
// happened. Rendered inside a shadow root so page CSS cannot restyle it.
// The host element is kept as a module-level reference (never looked up by
// id) so the page cannot substitute its own element.
const TOAST_COLORS: Record<HotkeyFeedbackMessage["outcome"], string> = {
  "preparing": "#2563eb",
  "started": "#16a34a",
  "delegated": "#2563eb",
  "complete": "#16a34a",
  "no-media": "#6b7280",
  "failed": "#dc2626",
};
const TOAST_LABELS: Record<HotkeyFeedbackMessage["outcome"], string> = {
  "preparing": "Preparing",
  "started": "Saving",
  "delegated": "Local downloader",
  "complete": "Saved",
  "no-media": "Nothing to save",
  "failed": "Not saved",
};
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastHost: HTMLElement | null = null;
let toastRoot: ShadowRoot | null = null;

function showToast(outcome: HotkeyFeedbackMessage["outcome"], detail: string): void {
  if (!document.body) return;
  if (!toastHost || !toastRoot || !toastHost.isConnected) {
    const host = document.createElement("div");
    host.setAttribute("data-savemedia", "feedback");
    try {
      toastRoot = host.attachShadow({ mode: "open" });
    } catch {
      return;
    }
    toastHost = host;
    document.body.appendChild(host);
  }
  const host = toastHost;
  const root = toastRoot;
  root.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .t { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; align-items: center; gap: 10px; max-width: 360px;
      padding: 10px 14px; border-radius: 8px; background: #0e1b26; color: #eef3f6;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,.35); opacity: 0; transform: translateY(6px);
      transition: opacity .18s ease, transform .18s ease; pointer-events: none; }
    .t.show { opacity: 1; transform: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .k { font-weight: 600; margin-right: 6px; }
    .d { color: #9fb2be; overflow-wrap: anywhere; }
    @media (prefers-reduced-motion: reduce) { .t { transition: none; } }
  `;
  const el = document.createElement("div");
  el.className = "t";
  el.setAttribute("role", outcome === "failed" ? "alert" : "status");
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = TOAST_COLORS[outcome];
  const label = document.createElement("span");
  label.className = "k";
  label.textContent = TOAST_LABELS[outcome];
  const text = document.createElement("span");
  text.className = "d";
  text.textContent = detail;
  el.append(dot, label, text);
  root.append(style, el);
  requestAnimationFrame(() => el.classList.add("show"));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => {
      if (el.parentNode !== root) return;
      host.remove();
      if (toastHost === host) {
        toastHost = null;
        toastRoot = null;
      }
    }, 250);
  }, outcome === "failed" ? 8_000 : outcome === "preparing" ? 12_000 : 2_400);
}

chrome.runtime.sendMessage(
  { type: "ready" },
  () => void chrome.runtime.lastError,
);

function isMainPayload(value: unknown): value is PageCapturePayload {
  if (!isRecord(value)) return false;
  if (value[BRIDGE_TAG] !== true || typeof value.pageUrl !== "string") return false;
  return isCaptureKind(value.kind)
    && (typeof value.url === "string" || value.url === null)
    && isOptionalStringRecord(value.responseHeaders)
    && isOptionalString(value.responseBodyHeadB64)
    && isOptionalString(value.keySystem)
    && isOptionalString(value.mimeType)
    && isOptionalMediaElementTag(value.elementTag)
    && isOptionalString(value.elementSrc)
    && isOptionalString(value.audioUrl);
}

function isDiscoverPageMediaMessage(value: unknown): value is DiscoverPageMediaMessage {
  return isRecord(value) && value.type === "discover-page-media";
}

function isHotkeyFeedbackMessage(value: unknown): value is HotkeyFeedbackMessage {
  return isRecord(value)
    && value.type === "hotkey-feedback"
    && (value.outcome === "preparing" || value.outcome === "started" || value.outcome === "delegated" || value.outcome === "complete" || value.outcome === "no-media" || value.outcome === "failed")
    && typeof value.detail === "string";
}

function isCaptureKind(value: unknown): value is CaptureKind {
  return typeof value === "string" && (CAPTURE_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringRecord(value: unknown): value is Readonly<Record<string, string>> | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(entry => typeof entry === "string");
}

function isOptionalMediaElementTag(value: unknown): value is "video" | "audio" | undefined {
  return value === undefined || value === "video" || value === "audio";
}
