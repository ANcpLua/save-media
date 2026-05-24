import type {
  StreamDescriptor,
  UserChoice,
  JobError,
} from "@savemedia/core";

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

export type BackgroundToContentMessage =
  | { readonly type: "discover-page-media" };

export interface ContentDiscoveryResponse {
  readonly pageUrl: string;
  readonly urls: readonly string[];
}

export type BackgroundToPopupMessage =
  | { readonly type: "descriptors"; readonly tabId: number; readonly descriptors: readonly StreamDescriptor[] }
  | { readonly type: "job-progress"; readonly streamId: StreamDescriptor["id"]; readonly bytesWritten: number; readonly bytesTotal: number | null; readonly phase: string }
  | { readonly type: "job-failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError }
  | { readonly type: "job-complete"; readonly streamId: StreamDescriptor["id"]; readonly path: string };

export type PopupToBackgroundMessage =
  | { readonly type: "list"; readonly tabId: number }
  | { readonly type: "download"; readonly streamId: StreamDescriptor["id"]; readonly choice: UserChoice }
  | { readonly type: "cancel"; readonly streamId: StreamDescriptor["id"] };

export type BackgroundToEngineMessage =
  | { readonly type: "start-job"; readonly streamId: StreamDescriptor["id"]; readonly descriptor: StreamDescriptor; readonly choice: UserChoice }
  | { readonly type: "cancel-job"; readonly streamId: StreamDescriptor["id"] };

export type EngineToBackgroundMessage =
  | { readonly type: "progress"; readonly streamId: StreamDescriptor["id"]; readonly bytesWritten: number; readonly bytesTotal: number | null; readonly phase: string }
  | { readonly type: "complete"; readonly streamId: StreamDescriptor["id"]; readonly blobUrl: string; readonly filename: string; readonly checksum: string }
  | { readonly type: "failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError };

export function isBridgeToBackgroundMessage(value: unknown): value is BridgeToBackgroundMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "ready":
      return true;
    case "download-best-hotkey":
      return typeof value.pageUrl === "string";
    case "capture":
      return isPageCaptureMessage(value.payload);
    default:
      return false;
  }
}

export function isPopupToBackgroundMessage(value: unknown): value is PopupToBackgroundMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "list":
      return typeof value.tabId === "number";
    case "download":
      return typeof value.streamId === "string" && isUserChoice(value.choice);
    case "cancel":
      return typeof value.streamId === "string";
    default:
      return false;
  }
}

export function isBackgroundToEngineMessage(value: unknown): value is BackgroundToEngineMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "start-job":
      return typeof value.streamId === "string" && isRecord(value.descriptor) && isUserChoice(value.choice);
    case "cancel-job":
      return typeof value.streamId === "string";
    default:
      return false;
  }
}

export function isEngineToBackgroundMessage(value: unknown): value is EngineToBackgroundMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "progress":
      return typeof value.streamId === "string"
        && typeof value.bytesWritten === "number"
        && (typeof value.bytesTotal === "number" || value.bytesTotal === null)
        && typeof value.phase === "string";
    case "complete":
      return typeof value.streamId === "string"
        && typeof value.blobUrl === "string"
        && typeof value.filename === "string"
        && typeof value.checksum === "string";
    case "failed":
      return typeof value.streamId === "string" && isRecord(value.error);
    default:
      return false;
  }
}

export function isBackgroundToPopupMessage(value: unknown): value is BackgroundToPopupMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "descriptors":
      return typeof value.tabId === "number" && Array.isArray(value.descriptors);
    case "job-progress":
      return typeof value.streamId === "string"
        && typeof value.bytesWritten === "number"
        && (typeof value.bytesTotal === "number" || value.bytesTotal === null)
        && typeof value.phase === "string";
    case "job-failed":
      return typeof value.streamId === "string" && isRecord(value.error);
    case "job-complete":
      return typeof value.streamId === "string" && typeof value.path === "string";
    default:
      return false;
  }
}

function isPageCaptureMessage(value: unknown): value is PageCaptureMessage {
  if (!isRecord(value)) return false;
  return value[MAIN_BRIDGE_TAG] === true
    && isCaptureKind(value.kind)
    && (typeof value.url === "string" || value.url === null)
    && typeof value.pageUrl === "string"
    && isOptionalStringRecord(value.responseHeaders)
    && isOptionalString(value.responseBodyHeadB64)
    && isOptionalString(value.keySystem)
    && isOptionalString(value.mimeType)
    && isOptionalMediaElementTag(value.elementTag)
    && isOptionalString(value.elementSrc);
}

function isUserChoice(value: unknown): value is UserChoice {
  if (!isRecord(value)) return false;
  return value.outputMode === "Original"
    && typeof value.filename === "string"
    && isStringOrNull(value.variantId)
    && isStringOrNull(value.audioRenditionId);
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

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isOptionalStringRecord(value: unknown): value is Readonly<Record<string, string>> | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(entry => typeof entry === "string");
}

function isOptionalMediaElementTag(value: unknown): value is "video" | "audio" | undefined {
  return value === undefined || value === "video" || value === "audio";
}
