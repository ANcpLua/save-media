import type {
  StreamDescriptor,
  UserChoice,
  JobError,
} from "@savemedia/core";
import { z } from "zod";
import {
  LOCAL_FAILURE_CODES,
  LOCAL_QUALITIES,
  COOKIE_BROWSERS,
  type HostPong,
  type LocalFailureCode,
  type LocalPhase,
} from "./native";
import type { CookieSource, LocalDownloaderSettings } from "../native/settings";

export const MAIN_BRIDGE_TAG = "__savemedia" as const;

const CAPTURE_KINDS = ["media-element", "media-source", "eme", "ms-probe"] as const;

export type CaptureKind = typeof CAPTURE_KINDS[number];

export interface PageCaptureMessage {
  readonly [MAIN_BRIDGE_TAG]: true;
  readonly kind: CaptureKind;
  readonly url: string | null;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly responseBodyHeadB64?: string;
  readonly keySystem?: string;
  readonly mimeType?: string;
  readonly elementTag?: "video" | "audio";
  readonly elementSrc?: string;
  /**
   * Companion audio-track URL for demuxed captures (separate video-only and
   * audio-only tracks): `url` is then the video-only half and the pair
   * downloads as one merged MP4. Mirrored in content/bridge.ts's hand-written
   * validator: update both.
   */
  readonly audioUrl?: string;
  readonly pageUrl: string;
}

export interface PageCommandMessage {
  readonly [MAIN_BRIDGE_TAG]: true;
  readonly kind: "download-best-hotkey";
  readonly pageUrl: string;
  readonly url?: null;
}

export type MainToBridgeMessage = PageCaptureMessage | PageCommandMessage;

export type BridgeToBackgroundMessage =
  | { readonly type: "capture"; readonly payload: PageCaptureMessage }
  | { readonly type: "download-best-hotkey"; readonly pageUrl: string }
  | { readonly type: "ready" };

export type HotkeyFeedbackOutcome = "started" | "delegated" | "complete" | "no-media" | "failed";

export type BackgroundToContentMessage =
  | { readonly type: "discover-page-media" }
  | { readonly type: "page-media-snapshot" }
  | { readonly type: "hotkey-feedback"; readonly outcome: HotkeyFeedbackOutcome; readonly detail: string };

/** One <video> element on the page, as seen by the bridge when the popup opens. */
export interface PageVideo {
  readonly src: string;
  /** Captured frame or poster as a data URL; null when the frame is cross-origin tainted and no poster exists. */
  readonly thumbnail: string | null;
  readonly width: number;
  readonly height: number;
  readonly duration: number | null;
  /** Fraction of the element inside the viewport, 0..1. */
  readonly visible: number;
  readonly playing: boolean;
}

export interface PageMediaSnapshot {
  readonly pageTitle: string;
  readonly videos: readonly PageVideo[];
}

export type CookieSourceValue = CookieSource;
export type LocalSettingsValue = LocalDownloaderSettings;

export interface LocalJobView {
  readonly id: string;
  readonly pageUrl: string;
  readonly tabId: number | null;
  readonly phase: LocalPhase | "complete" | "failed";
  readonly percent: number | null;
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
  readonly speedBytesPerSec: number | null;
  readonly etaSeconds: number | null;
  readonly filename: string | null;
  readonly failure: { readonly code: LocalFailureCode; readonly message: string } | null;
}

export interface ContentDiscoveryResponse {
  readonly pageUrl: string;
  readonly urls: readonly string[];
}

export type BackgroundToPopupMessage =
  | { readonly type: "descriptors"; readonly tabId: number; readonly descriptors: readonly StreamDescriptor[] }
  | { readonly type: "local-status"; readonly settings: LocalSettingsValue; readonly host: HostPong | null; readonly permissionGranted: boolean; readonly jobs: readonly LocalJobView[] }
  | { readonly type: "local-job"; readonly job: LocalJobView }
  | { readonly type: "job-progress"; readonly streamId: StreamDescriptor["id"]; readonly bytesWritten: number; readonly bytesTotal: number | null; readonly phase: string }
  | { readonly type: "job-failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError }
  | { readonly type: "job-complete"; readonly streamId: StreamDescriptor["id"]; readonly path: string };

export type PopupToBackgroundMessage =
  | { readonly type: "list"; readonly tabId: number }
  | { readonly type: "local-status" }
  | { readonly type: "local-settings"; readonly patch: Partial<LocalSettingsValue> }
  | { readonly type: "local-download"; readonly tabId: number | null; readonly pageUrl: string }
  | { readonly type: "local-cancel"; readonly id: string }
  | { readonly type: "download"; readonly streamId: StreamDescriptor["id"]; readonly choice: UserChoice }
  | { readonly type: "cancel"; readonly streamId: StreamDescriptor["id"] };

export type BackgroundToEngineMessage =
  | { readonly type: "start-job"; readonly streamId: StreamDescriptor["id"]; readonly descriptor: StreamDescriptor; readonly choice: UserChoice }
  | { readonly type: "cancel-job"; readonly streamId: StreamDescriptor["id"] };

export type EngineToBackgroundMessage =
  | { readonly type: "progress"; readonly streamId: StreamDescriptor["id"]; readonly bytesWritten: number; readonly bytesTotal: number | null; readonly phase: string }
  | { readonly type: "complete"; readonly streamId: StreamDescriptor["id"]; readonly blobUrl: string; readonly filename: string; readonly checksum: string }
  | { readonly type: "failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError };

// Runtime validation. These guards run in the background service worker, the
// offscreen engine document and the popup, where zod's size is irrelevant.
// content/bridge.ts runs in every frame of every page and keeps its own
// hand-written guards on purpose: zod would more than double that file.

const record = z.object({}).passthrough();
const streamId = z.string();
const stringOrNull = z.string().nullable();
const numberOrNull = z.number().nullable();

const pageCaptureSchema = z.object({
  [MAIN_BRIDGE_TAG]: z.literal(true),
  kind: z.enum(CAPTURE_KINDS),
  url: stringOrNull,
  pageUrl: z.string(),
  responseHeaders: z.record(z.string()).optional(),
  responseBodyHeadB64: z.string().optional(),
  keySystem: z.string().optional(),
  mimeType: z.string().optional(),
  elementTag: z.enum(["video", "audio"]).optional(),
  elementSrc: z.string().optional(),
  audioUrl: z.string().optional(),
});

const userChoiceSchema = z.object({
  outputMode: z.literal("Original"),
  filename: z.string(),
  variantId: stringOrNull,
  audioRenditionId: stringOrNull,
});

const cookieSourceSchema = z.union([z.literal("auto"), z.literal("none"), z.enum(COOKIE_BROWSERS)]);

const localSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  quality: z.enum(LOCAL_QUALITIES).optional(),
  cookies: cookieSourceSchema.optional(),
  fallbackOnHotkey: z.boolean().optional(),
});

const localJobViewSchema = z.object({
  id: z.string(),
  pageUrl: z.string(),
  tabId: numberOrNull,
  phase: z.string(),
  filename: stringOrNull,
  failure: z.object({ code: z.enum(LOCAL_FAILURE_CODES), message: z.string() }).nullable(),
});

const progressFields = {
  streamId,
  bytesWritten: z.number(),
  bytesTotal: numberOrNull,
  phase: z.string(),
};

const bridgeToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("download-best-hotkey"), pageUrl: z.string() }),
  z.object({ type: z.literal("capture"), payload: pageCaptureSchema }),
]);

const popupToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), tabId: z.number() }),
  z.object({ type: z.literal("local-status") }),
  z.object({ type: z.literal("local-settings"), patch: localSettingsPatchSchema }),
  z.object({ type: z.literal("local-download"), tabId: numberOrNull, pageUrl: z.string() }),
  z.object({ type: z.literal("local-cancel"), id: z.string() }),
  z.object({ type: z.literal("download"), streamId, choice: userChoiceSchema }),
  z.object({ type: z.literal("cancel"), streamId }),
]);

const backgroundToEngineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start-job"), streamId, descriptor: record, choice: userChoiceSchema }),
  z.object({ type: z.literal("cancel-job"), streamId }),
]);

const engineToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), ...progressFields }),
  z.object({ type: z.literal("complete"), streamId, blobUrl: z.string(), filename: z.string(), checksum: z.string() }),
  z.object({ type: z.literal("failed"), streamId, error: record }),
]);

const backgroundToPopupSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("descriptors"), tabId: z.number(), descriptors: z.array(z.unknown()) }),
  z.object({ type: z.literal("local-status"), settings: record, permissionGranted: z.boolean(), jobs: z.array(z.unknown()) }),
  z.object({ type: z.literal("local-job"), job: localJobViewSchema }),
  z.object({ type: z.literal("job-progress"), ...progressFields }),
  z.object({ type: z.literal("job-failed"), streamId, error: record }),
  z.object({ type: z.literal("job-complete"), streamId, path: z.string() }),
]);

export function isBridgeToBackgroundMessage(value: unknown): value is BridgeToBackgroundMessage {
  return bridgeToBackgroundSchema.safeParse(value).success;
}

export function isPopupToBackgroundMessage(value: unknown): value is PopupToBackgroundMessage {
  return popupToBackgroundSchema.safeParse(value).success;
}

export function isBackgroundToEngineMessage(value: unknown): value is BackgroundToEngineMessage {
  return backgroundToEngineSchema.safeParse(value).success;
}

export function isEngineToBackgroundMessage(value: unknown): value is EngineToBackgroundMessage {
  return engineToBackgroundSchema.safeParse(value).success;
}

export function isBackgroundToPopupMessage(value: unknown): value is BackgroundToPopupMessage {
  return backgroundToPopupSchema.safeParse(value).success;
}

export function isLocalJobView(value: unknown): value is LocalJobView {
  return localJobViewSchema.safeParse(value).success;
}
