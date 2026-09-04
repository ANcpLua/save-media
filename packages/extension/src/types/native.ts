/**
 * Wire protocol between the extension and the optional local downloader
 * host (`packages/native-host`). The host is a Native Messaging program the
 * user installs themselves; it runs the user's own yt-dlp and ffmpeg.
 *
 * The extension only ever sends a page URL plus a quality preference. It
 * never sends media URLs, keys, or page content. The host refuses DRM.
 */

export const NATIVE_HOST_NAME = "com.savemedia.host" as const;
export const NATIVE_PROTOCOL_VERSION = 1 as const;

export const LOCAL_QUALITIES = ["best", "1080", "720", "480"] as const;
export type LocalQuality = typeof LOCAL_QUALITIES[number];

export const COOKIE_BROWSERS = ["chrome", "chromium", "edge", "firefox", "brave"] as const;
export type CookieBrowser = typeof COOKIE_BROWSERS[number];

export const LOCAL_FAILURE_CODES = [
  "ytdlp_missing",
  "ffmpeg_missing",
  "drm_protected",
  "unsupported_url",
  "login_required",
  "geo_restricted",
  "network",
  "timeout",
  "cancelled",
  "invalid_request",
  "unknown",
  // Extension-side only: the host could not be reached at all.
  "host_unavailable",
] as const;
export type LocalFailureCode = typeof LOCAL_FAILURE_CODES[number];

export type LocalPhase = "probing" | "downloading" | "merging";

export type ExtensionToHostMessage =
  | { readonly type: "ping" }
  | {
    readonly type: "download";
    readonly id: string;
    readonly pageUrl: string;
    readonly quality: LocalQuality;
    readonly cookiesFromBrowser: CookieBrowser | null;
    readonly outputDir: string | null;
  }
  | { readonly type: "cancel"; readonly id: string };

export interface ToolInfo {
  readonly found: boolean;
  readonly version: string | null;
  readonly path: string | null;
}

export interface HostPong {
  readonly type: "pong";
  readonly hostVersion: string;
  readonly protocolVersion: number;
  readonly ytdlp: ToolInfo;
  readonly ffmpeg: ToolInfo;
  readonly outputDir: string;
}

export interface HostProgress {
  readonly type: "progress";
  readonly id: string;
  readonly phase: LocalPhase;
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
  readonly percent: number | null;
  readonly speedBytesPerSec: number | null;
  readonly etaSeconds: number | null;
}

export interface HostComplete {
  readonly type: "complete";
  readonly id: string;
  readonly filename: string;
  readonly path: string;
  readonly bytes: number | null;
}

export interface HostFailed {
  readonly type: "failed";
  readonly id: string;
  readonly code: LocalFailureCode;
  readonly message: string;
}

export type HostToExtensionMessage = HostPong | HostProgress | HostComplete | HostFailed;

export function isHostToExtensionMessage(value: unknown): value is HostToExtensionMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "pong":
      return typeof value.hostVersion === "string"
        && typeof value.protocolVersion === "number"
        && isToolInfo(value.ytdlp)
        && isToolInfo(value.ffmpeg)
        && typeof value.outputDir === "string";
    case "progress":
      return typeof value.id === "string"
        && (value.phase === "probing" || value.phase === "downloading" || value.phase === "merging")
        && isNumberOrNull(value.downloadedBytes)
        && isNumberOrNull(value.totalBytes)
        && isNumberOrNull(value.percent)
        && isNumberOrNull(value.speedBytesPerSec)
        && isNumberOrNull(value.etaSeconds);
    case "complete":
      return typeof value.id === "string"
        && typeof value.filename === "string"
        && typeof value.path === "string"
        && isNumberOrNull(value.bytes);
    case "failed":
      return typeof value.id === "string"
        && isLocalFailureCode(value.code)
        && typeof value.message === "string";
    default:
      return false;
  }
}

export function isLocalQuality(value: unknown): value is LocalQuality {
  return typeof value === "string" && (LOCAL_QUALITIES as readonly string[]).includes(value);
}

export function isCookieBrowser(value: unknown): value is CookieBrowser {
  return typeof value === "string" && (COOKIE_BROWSERS as readonly string[]).includes(value);
}

export function isLocalFailureCode(value: unknown): value is LocalFailureCode {
  return typeof value === "string" && (LOCAL_FAILURE_CODES as readonly string[]).includes(value);
}

function isToolInfo(value: unknown): value is ToolInfo {
  return isRecord(value)
    && typeof value.found === "boolean"
    && (typeof value.version === "string" || value.version === null)
    && (typeof value.path === "string" || value.path === null);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Human-readable text for a host failure, shown in the popup and the page toast. */
export function localFailureText(code: LocalFailureCode, message: string): { readonly title: string; readonly body: string } {
  switch (code) {
    case "host_unavailable":
      return {
        title: "Local downloader not reachable",
        body: "Install the host from the repository (packages/native-host) and reload the extension.",
      };
    case "ytdlp_missing":
      return { title: "yt-dlp not found", body: "Install yt-dlp on this computer, then try again." };
    case "ffmpeg_missing":
      return { title: "ffmpeg not found", body: "Install ffmpeg on this computer, then try again." };
    case "drm_protected":
      return { title: "Protected media", body: "This stream uses DRM. savemedia does not decrypt protected media." };
    case "unsupported_url":
      return { title: "Page not supported", body: "The local downloader has no handler for this page." };
    case "login_required":
      return { title: "Sign-in required", body: "Enable browser cookies in the local downloader settings and make sure you are signed in." };
    case "geo_restricted":
      return { title: "Not available in your region", body: "The site does not serve this media to your location." };
    case "network":
      return { title: "Network error", body: message || "The download could not be completed." };
    case "timeout":
      return { title: "Timed out", body: "The download took longer than 30 minutes and was stopped." };
    case "cancelled":
      return { title: "Cancelled", body: "The download was cancelled." };
    case "invalid_request":
      return { title: "Invalid request", body: message || "The host rejected the request." };
    case "unknown":
      return { title: "Download failed", body: message || "See the host log for details." };
  }
}
