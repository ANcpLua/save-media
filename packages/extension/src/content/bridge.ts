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
  if (!isDiscoverPageMediaMessage(msg)) return false;
  sendResponse({ pageUrl: location.href, urls: discoverMediaUrls() });
  return false;
});

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
    && isOptionalString(value.elementSrc);
}

function isDiscoverPageMediaMessage(value: unknown): value is DiscoverPageMediaMessage {
  return isRecord(value) && value.type === "discover-page-media";
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
