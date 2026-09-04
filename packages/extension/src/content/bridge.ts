// Content scripts in MV3 are injected as classic scripts — `import` is
// a syntax error. We intentionally duplicate this constant (also defined
// in src/types/messages.ts) so this file has no module dependencies and
// can ship as a standalone JS file.
//
// See content/main.ts for why the `export {}` marker is here.
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

interface PageCommandPayload {
  [BRIDGE_TAG]: true;
  kind: "download-best-hotkey";
  pageUrl: string;
}

type MainPayload = PageCapturePayload | PageCommandPayload;

interface DiscoverPageMediaMessage {
  type: "discover-page-media";
}

interface HotkeyFeedbackMessage {
  type: "hotkey-feedback";
  outcome: "started" | "delegated" | "complete" | "no-media" | "failed";
  detail: string;
}

window.addEventListener("message", event => {
  if (event.source !== window) return;
  const data = event.data;
  if (!isMainPayload(data)) return;
  if (data.kind === "download-best-hotkey") {
    chrome.runtime.sendMessage(
      { type: "download-best-hotkey", pageUrl: data.pageUrl },
      () => void chrome.runtime.lastError,
    );
    return;
  }
  chrome.runtime.sendMessage(
    { type: "capture", payload: data },
    () => void chrome.runtime.lastError,
  );
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (isHotkeyFeedbackMessage(msg)) {
    if (window.top === window) showToast(msg.outcome, msg.detail);
    return false;
  }
  if (isRecord(msg) && msg.type === "page-media-snapshot") {
    sendResponse(pageMediaSnapshot());
    return false;
  }
  if (!isDiscoverPageMediaMessage(msg)) return false;
  sendResponse({ pageUrl: location.href, urls: discoverMediaUrls() });
  return false;
});

// Snapshot of the page's <video> elements for the popup: which one is
// playing, how big it is, and a small frame so the user can tell entries
// apart. Frames of cross-origin media taint the canvas; then the poster is
// used, or nothing.
const THUMB_WIDTH = 160;

function pageMediaSnapshot(): {
  pageTitle: string;
  videos: { src: string; thumbnail: string | null; width: number; height: number; duration: number | null; visible: number; playing: boolean }[];
} {
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() || document.title;
  const videos = [...document.querySelectorAll("video")].map(v => ({
    src: v.currentSrc || v.src || v.querySelector("source")?.src || "",
    thumbnail: captureFrame(v) ?? (v.poster ? absolute(v.poster) : null),
    width: v.videoWidth || Math.round(v.getBoundingClientRect().width),
    height: v.videoHeight || Math.round(v.getBoundingClientRect().height),
    duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
    visible: visibleFraction(v),
    playing: !v.paused && !v.ended && v.readyState >= 2,
  })).filter(v => v.src || v.thumbnail);
  return { pageTitle: title, videos };
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
  "started": "#16a34a",
  "delegated": "#2563eb",
  "complete": "#16a34a",
  "no-media": "#6b7280",
  "failed": "#dc2626",
};
const TOAST_LABELS: Record<HotkeyFeedbackMessage["outcome"], string> = {
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
    .d { color: #9fb2be; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (prefers-reduced-motion: reduce) { .t { transition: none; } }
  `;
  const el = document.createElement("div");
  el.className = "t";
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
      host.remove();
      if (toastHost === host) {
        toastHost = null;
        toastRoot = null;
      }
    }, 250);
  }, outcome === "failed" ? 4_000 : 2_400);
}

chrome.runtime.sendMessage(
  { type: "ready" },
  () => void chrome.runtime.lastError,
);

function discoverMediaUrls(): string[] {
  const text = discoveryText();
  const normalized = text
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const seen = new Set<string>();
  const mediaUrl = /(?:(?:https?:)?\/\/|\/|\.\.?\/)[^\s"'<>]+?\.(?:m3u8|mpd|mp4|webm|mkv)(?:[^\s"'<>]*)?/gi;
  for (const match of normalized.matchAll(mediaUrl)) {
    const raw = match[0];
    if (!raw || looksLikeFragmentUrl(raw)) continue;
    try {
      seen.add(new URL(raw, location.href).href);
    } catch {
      // Ignore malformed ad/script tokens.
    }
    if (seen.size >= 80) break;
  }
  return [...seen];
}

function discoveryText(): string {
  const chunks: string[] = [];
  document.querySelectorAll("script").forEach(script => {
    if (script.textContent) chunks.push(script.textContent);
    if (script.src) chunks.push(script.src);
  });
  document.querySelectorAll("[src], [href]").forEach(el => {
    const src = (el as HTMLElement).getAttribute("src");
    const href = (el as HTMLElement).getAttribute("href");
    if (src) chunks.push(src);
    if (href) chunks.push(href);
  });
  chunks.push(document.documentElement.innerHTML.slice(0, 2_000_000));
  return chunks.join("\n");
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
  return /^(init|seg|segment|chunk|frag|fragment|part)[._-][a-z0-9._-]*\.mp4$/i.test(base);
}

function isMainPayload(value: unknown): value is MainPayload {
  if (!isRecord(value)) return false;
  if (value[BRIDGE_TAG] !== true || typeof value.pageUrl !== "string") return false;
  if (value.kind === "download-best-hotkey") return true;
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
    && (value.outcome === "started" || value.outcome === "delegated" || value.outcome === "complete" || value.outcome === "no-media" || value.outcome === "failed")
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
