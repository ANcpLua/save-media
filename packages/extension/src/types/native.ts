/**
 * Wire protocol between the extension and the optional local downloader
 * host (`packages/native-host`). The host is a Native Messaging program the
 * user installs themselves; it runs the user's own yt-dlp and ffmpeg.
 *
 * A yt-dlp job takes a page URL and quality preference.
 */

import { z } from "zod";

export const NATIVE_HOST_NAME = "com.savemedia.host" as const;
/**
 * The protocol this extension speaks, as the helper reports its own in `pong.protocolVersion`
 * (PROTOCOL_VERSION in packages/native-host/host.py). 2: a download may carry `allowWithoutCookies`,
 * a failure may carry `httpStatus`, and the helper classifies failures from yt-dlp's format data.
 * Raise both numbers together when a request or an answer changes its meaning.
 */
export const NATIVE_PROTOCOL_VERSION = 2 as const;

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
  "already_saved",
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
    /** The helper may run without cookies when the browser has no cookie database on this machine. */
    readonly allowWithoutCookies?: boolean;
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
  /** The HTTP status the downloader's final error line names. */
  readonly httpStatus?: number;
}

export type HostToExtensionMessage = HostPong | HostProgress | HostComplete | HostFailed;

// Validated with zod: this runs in the background service worker only.
const toolInfoSchema = z.object({
  found: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
});

const numberOrNull = z.number().nullable();

const hostToExtensionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pong"),
    hostVersion: z.string(),
    protocolVersion: z.number(),
    ytdlp: toolInfoSchema,
    ffmpeg: toolInfoSchema,
    outputDir: z.string(),
  }),
  z.object({
    type: z.literal("progress"),
    id: z.string(),
    phase: z.enum(["probing", "downloading", "merging"]),
    downloadedBytes: numberOrNull,
    totalBytes: numberOrNull,
    percent: numberOrNull,
    speedBytesPerSec: numberOrNull,
    etaSeconds: numberOrNull,
  }),
  z.object({
    type: z.literal("complete"),
    id: z.string(),
    filename: z.string(),
    path: z.string(),
    bytes: numberOrNull,
  }),
  z.object({
    type: z.literal("failed"),
    id: z.string(),
    code: z.enum(LOCAL_FAILURE_CODES),
    message: z.string(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }),
]);

/**
 * A helper that speaks an earlier protocol than this extension. It would ignore what it does not know
 * (a request's `allowWithoutCookies`) and answer without what this extension reads (`httpStatus`), so it
 * is not used: the user is asked to update it.
 */
export function helperOutdated(pong: HostPong): boolean {
  return pong.protocolVersion < NATIVE_PROTOCOL_VERSION;
}

export function isHostToExtensionMessage(value: unknown): value is HostToExtensionMessage {
  return hostToExtensionSchema.safeParse(value).success;
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
