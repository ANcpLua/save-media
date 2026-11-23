import type {
  StreamDescriptor,
  UserChoice,
  JobError,
} from "@savemedia/core";
import { z } from "zod";
import { httpObservationSchema, type HttpObservation } from "../util/http-diagnostics";
import { retainedPartialSchema, transferStageSchema, type RetainedPartial, type TransferStage } from "./transfer";
import {
  LOCAL_FAILURE_CODES,
  LOCAL_QUALITIES,
  COOKIE_BROWSERS,
  type HostPong,
  type LocalFailureCode,
  type LocalPhase,
} from "./native";
import type { CookieSource, LocalDownloaderSettings } from "../native/settings";
import type { FrameFacts, PageFileState, PreviewView, SelectionView } from "./page-facts";
import { FACT_LIMITS } from "../util/fact-limits";
import { PAGE_REACH_KINDS, type PageReachKind } from "../util/page-reach";
import { TOAST_OUTCOMES, type ToastOutcome } from "../ui/toast-text";

export const MAIN_BRIDGE_TAG = "__savemedia" as const;

const CAPTURE_KINDS = ["media-source", "ad-media"] as const;
const AD_VIAS = ["vast", "vmap", "hls-interstitial", "hls-asset-list"] as const;
export type AdVia = typeof AD_VIAS[number];

export type CaptureKind = typeof CAPTURE_KINDS[number];

export interface MediaQuality {
  readonly groupId: string;
  readonly height?: number;
}

/**
 * A media address to check, or the addresses a page's ad responses named.
 * `pageUrl` is informative only: the background takes the page and the
 * Referer from the message's sender, never from this field.
 */
export interface PageCaptureMessage {
  readonly [MAIN_BRIDGE_TAG]: true;
  readonly kind: CaptureKind;
  readonly url: string | null;
  /**
   * Companion audio-track URL for demuxed captures (separate video-only and
   * audio-only tracks): `url` is then the video-only half and the pair
   * downloads as one merged MP4.
   */
  readonly audioUrl?: string;
  readonly filenameHint?: string;
  readonly quality?: MediaQuality;
  readonly pageUrl: string;
  /** kind "ad-media": media files the page's ad responses named. Never requested. */
  readonly adUrls?: readonly string[];
  readonly adVia?: AdVia;
}

export type MainToBridgeMessage = PageCaptureMessage;

export type BridgeToBackgroundMessage =
  | { readonly type: "capture"; readonly payload: PageCaptureMessage }
  | { readonly type: "download-best-hotkey"; readonly pageUrl: string }
  /** A request in the document's resource timeline: the browser itself made it. */
  | { readonly type: "observed"; readonly url: string; readonly requestType: "media" | "xmlhttprequest"; readonly mime: string }
  /** A media element used a key: an encrypted event or a licence request. */
  | { readonly type: "eme"; readonly via: "license-request" | "encrypted"; readonly keySystem: string | null;
      readonly elementKey: string | null; readonly elementSrc: string | null }
  /** A frame's document became active. Answered with whether the command is bound to Alt+S. */
  | { readonly type: "frame-active"; readonly reason: "load" | "restore"; readonly url: string };

/**
 * What an Alt+S press led to. "waiting": nothing failed, but the page has not handed over the media yet.
 * "asked": the file was saved before and the question whether to save it again is open. "cancelled": the
 * user stopped the save.
 */
export type HotkeyFeedbackOutcome = ToastOutcome;
export const HOTKEY_FEEDBACK_OUTCOMES = TOAST_OUTCOMES;

export type BackgroundToContentMessage =
  | { readonly type: "collect-facts"; readonly pointer: boolean; readonly thumbnails: boolean }
  | { readonly type: "file-save-state"; readonly pageUrl: string }
  | FileSaveProblemMessage
  | { readonly type: "hotkey-feedback"; readonly outcome: HotkeyFeedbackOutcome; readonly detail: string };

export interface FileRecoveryProgress {
  readonly stage: TransferStage;
  readonly bytesWritten: number;
  readonly bytesTotal: number | null;
}

/** A file link the page declares in its own markup, with the name it gives the file. */
export interface FileDownloadOffer {
  readonly filename: string;
  readonly url: string;
}

export const FILE_SAVE_STAGES = ["checking", "starting", "transferring"] as const;

/**
 * Why the file a page names could not be saved. `stage` is where it stopped: while its link was
 * checked, when the save started, or while the browser continued its own interrupted download.
 * `error` is null when the save never started; the text is written from the error where it is shown.
 */
export interface FileSaveProblem {
  readonly filename: string;
  readonly stage: typeof FILE_SAVE_STAGES[number];
  readonly error: JobError | null;
}

export interface FileSaveProblemMessage {
  readonly type: "file-save-problem";
  readonly tabId: number;
  readonly pageUrl: string;
  readonly problem: FileSaveProblem | null;
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
  /** `message` is the downloader's own last line: technical detail, never main text. */
  readonly failure: { readonly code: LocalFailureCode; readonly message: string; readonly httpStatus?: number | null } | null;
}

export interface DiscoveryFailure {
  readonly url: string;
  readonly error: JobError;
}

export const JOB_PHASES = ["queued", "active", "complete", "failed", "cancelled"] as const;

export interface JobStatus {
  readonly fileName?: string;
  /** "cancelled": the user stopped the save. It carries no error and is never shown as a failure. */
  readonly phase: typeof JOB_PHASES[number];
  readonly bytesWritten?: number;
  readonly bytesTotal?: number | null;
  readonly stage?: TransferStage;
  /** When the stage began, in ms since the epoch. */
  readonly stageSince?: number;
  readonly savedAs?: string;
  readonly error?: JobError;
  /** A failed direct save whose verified bytes the engine keeps for Retry save. */
  readonly retained?: RetainedPartial;
}

/** The reply to a popup request whose handler failed: the popup keeps what it shows. */
export const REQUEST_FAILED = { type: "request-failed" } as const;

/** What a Save from a card led to. "listing-expired": the row is no longer known, so the popup looks again. */
export type DownloadResult =
  | { readonly type: "download-result"; readonly outcome: "started" | "skipped" | "listing-expired" }
  | { readonly type: "download-result"; readonly outcome: "failed"; readonly error: JobError };

export interface RepeatPromptView { readonly id: string; readonly filename: string; readonly tabId: number; readonly pageUrl: string }

/** The page's save state the popup asks for: an open repeat question, Chrome's own resume, and whether the named file was saved. */
export interface SaveState {
  readonly prompt: RepeatPromptView | null;
  readonly recovery: FileRecoveryProgress | null;
  readonly saved?: boolean;
}

export type BackgroundToPopupMessage =
  | DescriptorsMessage
  /** A repeat question appeared or ended. A popup that shows the page answers true. */
  | { readonly type: "repeat-save-changed"; readonly tabId: number; readonly pageUrl: string }
  | { readonly type: "file-recovery-progress"; readonly tabId: number; readonly pageUrl: string; readonly progress: FileRecoveryProgress | null }
  | FileSaveProblemMessage
  | { readonly type: "local-status"; readonly settings: LocalSettingsValue; readonly host: HostPong | null; readonly permissionGranted: boolean; readonly jobs: readonly LocalJobView[] }
  | { readonly type: "local-job"; readonly job: LocalJobView }
  | { readonly type: "job-progress"; readonly streamId: StreamDescriptor["id"]; readonly bytesWritten: number; readonly bytesTotal: number | null;
      readonly stage: TransferStage; readonly stageSince?: number }
  | { readonly type: "job-failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError; readonly retained?: RetainedPartial }
  /** The user stopped the save. Not a failure. */
  | { readonly type: "job-cancelled"; readonly streamId: StreamDescriptor["id"] }
  | { readonly type: "job-complete"; readonly streamId: StreamDescriptor["id"]; readonly path: string };

/**
 * The tab's view: the listed cards' descriptors (plus running jobs), the
 * failures to show, and the one selection the popup card, the Main badge, the
 * toolbar count, Save and Alt+S all follow.
 */
export interface DescriptorsMessage {
  readonly type: "descriptors";
  readonly tabId: number;
  readonly descriptors: readonly StreamDescriptor[];
  readonly failures?: readonly DiscoveryFailure[];
  readonly statuses?: Readonly<Record<string, JobStatus>>;
  readonly selection?: SelectionView;
  readonly previews?: Readonly<Record<string, PreviewView>>;
  readonly page?: PageFileState | null;
  /** False when the tab's content script cannot be reached. */
  readonly reachable?: boolean;
  /** Why the page cannot be read, when it cannot. */
  readonly reach?: PageReachKind | null;
  /**
   * The address of the tab's top frame as the browser reports it now. A page can change its own address
   * without loading (a feed that advances, a player that rewrites it): the popup follows it, so the page
   * it names in a request is the page its list shows.
   */
  readonly pageUrl?: string;
  /**
   * Only in the answer to "download-page": the save did not start. could-not-start: the page's own script
   * does not answer, or the request failed. page-changed: the tab shows another page than the popup did.
   */
  readonly notSaved?: "could-not-start" | "page-changed";
}

export type PopupToBackgroundMessage =
  | { readonly type: "list"; readonly tabId: number }
  | { readonly type: "rescan"; readonly tabId: number; readonly retryFailed?: boolean }
  /**
   * `ids`: the streams of the card the user clicked, best first, so that card is what is saved.
   * `allowRepeat`: the user pressed "Save another copy", which is the answer to the repeat question.
   */
  | { readonly type: "download-page"; readonly tabId: number; readonly pageUrl: string; readonly ids?: readonly StreamDescriptor["id"][] | undefined;
      readonly allowRepeat?: boolean | undefined }
  | { readonly type: "local-status" }
  | { readonly type: "local-settings"; readonly patch: Partial<LocalSettingsValue> }
  | { readonly type: "local-download"; readonly tabId: number | null; readonly pageUrl: string }
  | { readonly type: "local-cancel"; readonly id: string }
  | { readonly type: "download"; readonly streamId: StreamDescriptor["id"]; readonly choice: UserChoice; readonly allowRepeat?: boolean | undefined }
  | { readonly type: "cancel"; readonly streamId: StreamDescriptor["id"] }
  | { readonly type: "export-save-diagnostics"; readonly tabId: number; readonly pageUrl: string }
  | { readonly type: "current-save-state"; readonly tabId: number; readonly pageUrl: string; readonly offer?: FileDownloadOffer | undefined }
  | { readonly type: "answer-repeat-save"; readonly id: string; readonly allow: boolean };

export type PopupRequest = PopupToBackgroundMessage;
type LocalStatusMessage = Extract<BackgroundToPopupMessage, { type: "local-status" }>;
interface PopupReplies {
  "list": DescriptorsMessage; "rescan": DescriptorsMessage; "download-page": DescriptorsMessage;
  "download": DownloadResult; "cancel": { readonly ok: true };
  "local-status": LocalStatusMessage; "local-settings": LocalStatusMessage; "local-download": LocalStatusMessage; "local-cancel": LocalStatusMessage;
  "export-save-diagnostics": { readonly ok: boolean }; "current-save-state": SaveState; "answer-repeat-save": { readonly ok: boolean };
}
export type PopupReply<T extends PopupRequest["type"]> = PopupReplies[T];

/**
 * A popup or detached window says which tab it shows, over a port it keeps
 * open. The background sends a tab's list only while a view shows that tab,
 * and job updates only while any view is open.
 */
export const VIEW_PORT = "savemedia-view" as const;
export interface ViewMessage { readonly type: "view"; readonly tabId: number | null }

// The engine runs in its own document (Chromium) and talks to the background
// over one port. The port is also the liveness signal: a disconnect the
// background did not ask for means the engine is gone.
export const ENGINE_PORT = "savemedia-engine" as const;
export const ENGINE_PROTOCOL = 1 as const;
/** Sent with runtime.sendMessage to the engine document, which connects its port and answers { ok: true }. */
export interface EngineWake { readonly type: "engine-connect" }

export type BackgroundToEngineMessage =
  /** The background has taken in the engine's hello: queued messages may flow. */
  | { readonly type: "welcome" }
  /**
   * `localOrigins`: the origins inside the user's network that the browser itself was answered from in the job's
   * tab. For a page on the internet, the job requests no other server there.
   */
  | { readonly type: "start-job"; readonly streamId: StreamDescriptor["id"]; readonly descriptor: StreamDescriptor; readonly choice: UserChoice; readonly resumeKey?: string;
      readonly localOrigins?: readonly string[] }
  | { readonly type: "cancel-job"; readonly streamId: StreamDescriptor["id"] }
  /** Frees an output Blob. It also acknowledges the "complete" or "image-complete" that announced it. */
  | { readonly type: "release-output"; readonly blobUrl: string }
  /** Acknowledges a "failed": the engine need not report it again. */
  | { readonly type: "ack"; readonly streamId: StreamDescriptor["id"] }
  /** The answer to "prepare-requests". Always sent, also when preparing failed. */
  | { readonly type: "requests-prepared"; readonly requestId: number }
  /** Fetch one image once, verify its bytes, and hand back exactly those bytes. */
  | { readonly type: "start-image"; readonly streamId: string; readonly url: string; readonly pageUrl?: string | undefined;
      readonly localOrigins?: readonly string[] | undefined };

/** What the engine reports when its port opens: enough for the background to pick up where a restart left off. */
export interface EngineHello {
  readonly type: "engine-hello";
  readonly protocol: typeof ENGINE_PROTOCOL;
  readonly active: readonly { readonly streamId: StreamDescriptor["id"]; readonly progress: TransferProgressView | null }[];
  /** Results the background has not acknowledged yet. */
  readonly outbox: readonly EngineTerminal[];
  /** The resume scope of the bytes the engine keeps for Retry save, if any. */
  readonly retained: string | null;
  /** Nothing keeps the engine document needed. */
  readonly idle: boolean;
}
export interface TransferProgressView { readonly bytesWritten: number; readonly bytesTotal: number | null; readonly stage: TransferStage }
export type EngineTerminal = Extract<EngineEvent, { type: "complete" | "failed" | "image-complete" }>;
export type EngineToBackgroundMessage = EngineEvent | EngineHello;

export type EngineEvent =
  | { readonly type: "transfer-http"; readonly streamId: StreamDescriptor["id"]; readonly observation: HttpObservation }
  | { readonly type: "progress"; readonly streamId: StreamDescriptor["id"]; readonly bytesWritten: number; readonly bytesTotal: number | null; readonly stage: TransferStage }
  | { readonly type: "complete"; readonly streamId: StreamDescriptor["id"]; readonly blobUrl: string; readonly filename: string; readonly checksum: string }
  | { readonly type: "failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError; readonly retained?: RetainedPartial }
  /** Asks for the page's Referer on these media origins (one address each) before the job requests them; answered once the rules are in place. */
  | { readonly type: "prepare-requests"; readonly requestId: number; readonly streamId: StreamDescriptor["id"]; readonly urls: readonly string[] }
  /** No job is active, no output Blob is unreleased and no bytes are retained: the engine document may close. */
  | { readonly type: "idle" }
  /** An error nothing in the engine document caught. The background logs it with the extension's other errors. */
  | { readonly type: "engine-fault"; readonly detail: string }
  /** The bytes this stream's failed save kept are released: another failed save took the engine's one slot. */
  | { readonly type: "retained-released"; readonly streamId: StreamDescriptor["id"] }
  | { readonly type: "image-complete"; readonly streamId: string; readonly blobUrl: string; readonly filename: string }
  | { readonly type: "image-refused"; readonly streamId: string; readonly received: "page" | "program" | "data" | "unknown" }
  | { readonly type: "image-failed"; readonly streamId: string; readonly error: JobError };

// Runtime validation. These guards run in the background service worker, the
// offscreen engine document and the popup, where zod's size is irrelevant.
// content/bridge.ts runs in every frame of every page and keeps its own
// hand-written guards on purpose: zod would more than double that file.

const record = z.looseObject({});
const streamId = z.string();
const stringOrNull = z.string().nullable();
const numberOrNull = z.number().nullable();

const address = z.string().max(8192);
/** What a page's bridge may name: an http(s) address, as the bridge's own guard requires (content/capture-guard.ts). */
const webAddress = address.regex(/^https?:\/\//i);
const pageCaptureSchema = z.object({
  [MAIN_BRIDGE_TAG]: z.literal(true),
  kind: z.enum(CAPTURE_KINDS),
  url: webAddress.nullable(),
  pageUrl: z.string().max(65536),
  audioUrl: webAddress.optional(),
  filenameHint: z.string().max(240).optional(),
  quality: z.object({ groupId: z.string().min(1).max(8192), height: z.number().int().min(1).max(16384).optional() }).optional(),
  adUrls: z.array(webAddress).max(100).optional(),
  adVia: z.enum(AD_VIAS).optional(),
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
  failure: z.object({ code: z.enum(LOCAL_FAILURE_CODES), message: z.string(), httpStatus: z.number().int().min(100).max(599).nullable().optional() }).nullable(),
});

// A descriptor is built by core's classifier in the background. The engine
// still checks the fields it acts on before it requests anything for one.
const descriptorSchema = z.looseObject({
  id: streamId, tabId: z.number().int(), pageUrl: z.string().max(65536),
  source: z.discriminatedUnion("kind", [
    z.looseObject({ kind: z.literal("direct-url"), url: address }),
    z.looseObject({ kind: z.literal("hls-manifest"), manifestUrl: address, type: z.enum(["master", "media"]) }),
    z.looseObject({ kind: z.literal("dash-manifest"), manifestUrl: address }),
    z.looseObject({ kind: z.literal("media-element"), elementSrc: z.string() }),
  ]),
  protocol: z.string().max(40), container: z.string().max(40),
  variants: z.array(z.looseObject({ id: z.string() })).max(4096),
  capabilities: z.looseObject({ directDownload: z.boolean() }),
});

const progressFields = {
  streamId,
  bytesWritten: z.number(),
  bytesTotal: numberOrNull,
  stage: transferStageSchema,
};

const bridgeToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("download-best-hotkey"), pageUrl: z.string().max(65536) }),
  z.object({ type: z.literal("observed"), url: webAddress, requestType: z.enum(["media", "xmlhttprequest"]), mime: z.string().max(200) }),
  z.object({ type: z.literal("eme"), via: z.enum(["license-request", "encrypted"]), keySystem: z.string().max(200).nullable(),
    elementKey: z.string().max(40).nullable(), elementSrc: webAddress.nullable() }),
  z.object({ type: z.literal("frame-active"), reason: z.enum(["load", "restore"]), url: z.string().max(65536) }),
  z.object({ type: z.literal("capture"), payload: pageCaptureSchema }),
]);

const popupToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), tabId: z.number() }),
  z.object({ type: z.literal("rescan"), tabId: z.number(), retryFailed: z.boolean().optional() }),
  z.object({ type: z.literal("download-page"), tabId: z.number(), pageUrl: z.string(), ids: z.array(streamId).max(100).optional(),
    allowRepeat: z.boolean().optional() }),
  z.object({ type: z.literal("local-status") }),
  z.object({ type: z.literal("local-settings"), patch: localSettingsPatchSchema }),
  z.object({ type: z.literal("local-download"), tabId: numberOrNull, pageUrl: z.string() }),
  z.object({ type: z.literal("local-cancel"), id: z.string() }),
  z.object({ type: z.literal("download"), streamId, choice: userChoiceSchema, allowRepeat: z.boolean().optional() }),
  z.object({ type: z.literal("cancel"), streamId }),
  z.object({ type: z.literal("export-save-diagnostics"), tabId: z.number(), pageUrl: z.string() }),
  z.object({ type: z.literal("current-save-state"), tabId: z.number(), pageUrl: z.string(),
    offer: z.object({ filename: z.string().max(240), url: address }).optional() }),
  z.object({ type: z.literal("answer-repeat-save"), id: z.string().max(100), allow: z.boolean() }),
]);

/** Origins as the tab's store keeps them: at most as many as it keeps. */
const localOriginsSchema = z.array(z.string().max(300)).max(64);

const backgroundToEngineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome") }),
  z.object({ type: z.literal("start-job"), streamId, descriptor: descriptorSchema, choice: userChoiceSchema, resumeKey: z.string().max(100).optional(),
    localOrigins: localOriginsSchema.optional() }),
  z.object({ type: z.literal("cancel-job"), streamId }),
  z.object({ type: z.literal("release-output"), blobUrl: z.string().startsWith("blob:") }),
  z.object({ type: z.literal("ack"), streamId }),
  z.object({ type: z.literal("requests-prepared"), requestId: z.number().int() }),
  z.object({ type: z.literal("start-image"), streamId: z.string().startsWith("image:"), url: z.string().regex(/^(https?|data):/i),
    pageUrl: z.string().max(65536).optional(), localOrigins: localOriginsSchema.optional() }),
]);

const jobErrorSchema = z.looseObject({ code: z.string().max(80), severity: z.enum(["terminal", "recoverable"]) });
const fileSaveProblemSchema = z.object({ filename: z.string().max(240), stage: z.enum(FILE_SAVE_STAGES), error: jobErrorSchema.nullable() });
const completeSchema = z.object({ type: z.literal("complete"), streamId, blobUrl: z.string(), filename: z.string(), checksum: z.string() });
const failedSchema = z.object({ type: z.literal("failed"), streamId, error: jobErrorSchema, retained: retainedPartialSchema.optional() });
const imageCompleteSchema = z.object({ type: z.literal("image-complete"), streamId: z.string().startsWith("image:"),
  blobUrl: z.string().startsWith("blob:"), filename: z.string().max(255) });
const transferProgressSchema = z.object({ bytesWritten: z.number(), bytesTotal: numberOrNull, stage: transferStageSchema });

const engineToBackgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("engine-hello"), protocol: z.literal(ENGINE_PROTOCOL),
    active: z.array(z.object({ streamId, progress: transferProgressSchema.nullable() })).max(256),
    outbox: z.array(z.discriminatedUnion("type", [completeSchema, failedSchema, imageCompleteSchema])).max(256),
    retained: z.string().max(200).nullable(), idle: z.boolean() }),
  z.object({ type: z.literal("transfer-http"), streamId, observation: httpObservationSchema }),
  z.object({ type: z.literal("progress"), ...progressFields }),
  completeSchema,
  failedSchema,
  z.object({ type: z.literal("prepare-requests"), requestId: z.number().int(), streamId, urls: z.array(z.url({ protocol: /^https?$/ })).max(4096) }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("engine-fault"), detail: z.string().max(500) }),
  z.object({ type: z.literal("retained-released"), streamId }),
  imageCompleteSchema,
  z.object({ type: z.literal("image-refused"), streamId: z.string().startsWith("image:"), received: z.enum(["page", "program", "data", "unknown"]) }),
  z.object({ type: z.literal("image-failed"), streamId: z.string().startsWith("image:"), error: jobErrorSchema }),
]);

const descriptorsSchema = z.object({ type: z.literal("descriptors"), tabId: z.number(), descriptors: z.array(z.unknown()),
  failures: z.array(z.object({ url: z.string(), error: record })).optional(),
  statuses: z.record(z.string(), z.object({ phase: z.enum(JOB_PHASES),
    fileName: z.string().optional(), bytesWritten: z.number().optional(), bytesTotal: numberOrNull.optional(), stage: transferStageSchema.optional(),
    stageSince: z.number().optional(),
    savedAs: z.string().optional(), error: record.optional(), retained: retainedPartialSchema.optional() })).optional(),
  selection: record.optional(), previews: z.record(z.string(), record).optional(), page: record.nullable().optional(),
  reachable: z.boolean().optional(), reach: z.enum(PAGE_REACH_KINDS).nullable().optional(),
  pageUrl: z.string().optional(), notSaved: z.enum(["could-not-start", "page-changed"]).optional() });
const localStatusSchema = z.object({ type: z.literal("local-status"), settings: record, permissionGranted: z.boolean(), jobs: z.array(z.unknown()) });
const recoveryProgressSchema = z.object({ stage: transferStageSchema, bytesWritten: z.number(), bytesTotal: numberOrNull });
const okSchema = z.object({ ok: z.boolean() });
const downloadResultSchema = z.object({ type: z.literal("download-result"), outcome: z.enum(["started", "skipped", "listing-expired", "failed"]),
  error: jobErrorSchema.optional() }).refine(value => (value.outcome === "failed") === (value.error !== undefined));
const saveStateSchema = z.object({
  prompt: z.object({ id: z.string(), filename: z.string(), tabId: z.number(), pageUrl: z.string() }).nullable(),
  recovery: recoveryProgressSchema.nullable(), saved: z.boolean().optional() });

const POPUP_REPLIES: { readonly [T in PopupRequest["type"]]: z.ZodType } = {
  "list": descriptorsSchema, "rescan": descriptorsSchema, "download-page": descriptorsSchema,
  "download": downloadResultSchema, "cancel": z.object({ ok: z.literal(true) }),
  "local-status": localStatusSchema, "local-settings": localStatusSchema, "local-download": localStatusSchema, "local-cancel": localStatusSchema,
  "export-save-diagnostics": okSchema, "current-save-state": saveStateSchema, "answer-repeat-save": okSchema,
};

const backgroundToPopupSchema = z.discriminatedUnion("type", [
  descriptorsSchema,
  z.object({ type: z.literal("repeat-save-changed"), tabId: z.number(), pageUrl: z.string() }),
  z.object({ type: z.literal("file-recovery-progress"), tabId: z.number(), pageUrl: z.string(), progress: recoveryProgressSchema.nullable() }),
  z.object({ type: z.literal("file-save-problem"), tabId: z.number(), pageUrl: z.string(), problem: fileSaveProblemSchema.nullable() }),
  localStatusSchema,
  z.object({ type: z.literal("local-job"), job: localJobViewSchema }),
  z.object({ type: z.literal("job-progress"), ...progressFields, stageSince: z.number().optional() }),
  z.object({ type: z.literal("job-failed"), streamId, error: jobErrorSchema, retained: retainedPartialSchema.optional() }),
  z.object({ type: z.literal("job-cancelled"), streamId }),
  z.object({ type: z.literal("job-complete"), streamId, path: z.string() }),
]);

const viewSchema = z.object({ type: z.literal("view"), tabId: z.number().int().nullable() });

function parse<T>(schema: z.ZodType, value: unknown): T | null {
  return schema.safeParse(value).success ? value as T : null;
}

/** A popup request, or null. The dispatcher has already checked who sent it. */
export function parsePopupRequest(raw: unknown): PopupRequest | null {
  return parse(popupToBackgroundSchema, raw);
}

/** The background's reply to a popup request: null for a failed request and for anything that is not that reply. */
export function parsePopupReply<T extends PopupRequest["type"]>(type: T, raw: unknown): PopupReply<T> | null {
  return parse(POPUP_REPLIES[type], raw);
}

export function parseBridgeRequest(raw: unknown): BridgeToBackgroundMessage | null {
  return parse(bridgeToBackgroundSchema, raw);
}

/** A message the background sends to open views. */
export function parseBroadcast(raw: unknown): BackgroundToPopupMessage | null {
  return parse(backgroundToPopupSchema, raw);
}

export function parseEngineToBackground(raw: unknown): EngineToBackgroundMessage | null {
  return parse(engineToBackgroundSchema, raw);
}

export function parseBackgroundToEngine(raw: unknown): BackgroundToEngineMessage | null {
  return parse(backgroundToEngineSchema, raw);
}

export function parseViewMessage(raw: unknown): ViewMessage | null {
  return parse(viewSchema, raw);
}

export function isEngineWake(raw: unknown): raw is EngineWake {
  return !!raw && typeof raw === "object" && (raw as { type?: unknown }).type === "engine-connect" && Object.keys(raw).length === 1;
}

// Facts a frame's content script answers with. A page cannot write these
// messages, but a frame is still an untrusted reporter: every list and string
// is bounded before the selector reads it.
const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const declaredSource = z.object({ url: address, groupId: address, height: z.number().int().min(1).max(16384).optional(),
  mime: z.string().max(200).optional(), filenameHint: z.string().max(240).optional() });
const declaredGroup = z.object({ groupId: address, via: z.enum(["element", "attribute", "script", "json-ld", "og", "link"]),
  proximity: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), primary: z.boolean(), sources: z.array(declaredSource).max(80) });
const elementKey = z.string().max(40);
const canvasFeedFact = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("element"), key: elementKey }),
  z.object({ kind: z.literal("several-playing") }),
  z.object({ kind: z.literal("none") }),
]);
const pointerLayer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("video"), key: elementKey, via: z.enum(["stack", "geometry"]) }),
  z.object({ kind: z.literal("canvas"), feed: canvasFeedFact }),
  z.object({ kind: z.literal("image"), url: z.string().max(FACT_LIMITS.imageUrl), decorative: z.boolean(), posterOf: elementKey.nullable(),
    declaredThumbnail: z.boolean(), belowCanvas: z.boolean(), loaded: z.boolean() }),
  z.object({ kind: z.literal("frame"), index: z.number().int().min(0) }),
]);
const elementFact = z.object({
  key: elementKey,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("url"), url: address }),
    z.object({ kind: z.literal("blob"), url: address }),
    z.object({ kind: z.literal("media-source") }),
    z.object({ kind: z.literal("stream") }),
    z.object({ kind: z.literal("none") }),
  ]),
  groups: z.array(declaredGroup).max(80),
  render: z.enum(["visible", "offscreen", "hidden"]),
  box: rect, visible: rect.nullable(), canvas: rect.nullable(),
  playing: z.boolean(), played: z.boolean(), audible: z.boolean(), muted: z.boolean(),
  duration: z.number().positive().nullable(), live: z.boolean(), pip: z.boolean(), fullscreen: z.boolean(),
  keyed: z.object({ keySystem: z.string().max(200).nullable() }).nullable(),
  width: z.number(), height: z.number(),
  poster: address.nullable(),
  // Only a frame the bridge captured: never an address the popup would have to request.
  thumbnail: z.string().max(FACT_LIMITS.thumbnail).startsWith("data:image/").nullable().optional(),
});
const fileOffer = z.object({ filename: z.string().max(240), url: address });
const pageFileStateSchema = z.object({ title: z.string().max(FACT_LIMITS.title), fileDownload: fileOffer.optional(),
  namedFile: z.string().max(240).optional(), fileSaveProblem: fileSaveProblemSchema.nullable().optional() });

/** The top frame's answer to file-save-state (the same state its facts carry as `page`), or null when it is not one. */
export function parsePageFileState(value: unknown): PageFileState | null {
  const parsed = pageFileStateSchema.safeParse(value);
  return parsed.success ? parsed.data as PageFileState : null;
}

const frameFactsSchema = z.object({
  url: z.string().max(65536),
  top: z.boolean(),
  path: z.array(z.number().int().min(0)).max(32).nullable(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  childFrames: z.array(z.object({ index: z.number().int().min(0), box: rect, visible: rect.nullable() })).max(FACT_LIMITS.childFrames),
  elements: z.array(elementFact).max(FACT_LIMITS.elements),
  pageGroups: z.array(declaredGroup).max(80),
  pointer: z.object({ at: z.number(), x: z.number(), y: z.number(), overFrame: z.number().int().min(0).nullable(),
    layers: z.array(pointerLayer).max(FACT_LIMITS.layers) }).nullable(),
  page: pageFileStateSchema.optional(),
});

/** A frame's answer to collect-facts, or null when it is not one. */
export function parseFrameFacts(value: unknown): FrameFacts | null {
  const parsed = frameFactsSchema.safeParse(value);
  return parsed.success ? parsed.data as FrameFacts : null;
}

// The schema drops fields it does not name, so a fact added to the type alone would vanish without an
// error. These lines stop compiling when the type and the schema name different fields.
type SchemaFacts = z.infer<typeof frameFactsSchema>;
type SameFields<A, B> = [keyof A] extends [keyof B] ? [keyof B] extends [keyof A] ? true : never : never;
export const FRAME_FACT_FIELDS_MATCH: readonly true[] = [
  true satisfies SameFields<Required<FrameFacts>, Required<SchemaFacts>>,
  true satisfies SameFields<Required<FrameFacts["elements"][number]>, Required<SchemaFacts["elements"][number]>>,
  true satisfies SameFields<NonNullable<FrameFacts["pointer"]>, NonNullable<SchemaFacts["pointer"]>>,
  true satisfies SameFields<Required<NonNullable<FrameFacts["page"]>>, Required<NonNullable<SchemaFacts["page"]>>>,
  true satisfies SameFields<Required<FrameFacts["pageGroups"][number]>, Required<SchemaFacts["pageGroups"][number]>>,
  true satisfies SameFields<Required<FrameFacts["pageGroups"][number]["sources"][number]>, Required<SchemaFacts["pageGroups"][number]["sources"][number]>>,
];
