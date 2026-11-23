import { describe, expect, it } from "vitest";
import {
  ENGINE_PORT, MAIN_BRIDGE_TAG, REQUEST_FAILED, VIEW_PORT, isEngineWake, parseBackgroundToEngine, parseBridgeRequest, parseBroadcast, parseEngineToBackground,
  parsePopupReply, parsePopupRequest, parseViewMessage,
  type BackgroundToEngineMessage, type BackgroundToPopupMessage, type BridgeToBackgroundMessage, type EngineToBackgroundMessage, type PopupReply, type PopupRequest,
} from "../../../src/types/messages";
import { mainPayload } from "../../../src/content/capture-guard";
import { directDescriptor } from "../popup/helpers/descriptors";

const choice = { outputMode: "Original", filename: "clip.mp4", variantId: null, audioRenditionId: null } as const;
const id = "stream-1" as never;
const stage = { kind: "downloading" } as const;
const error = { code: "server_busy", severity: "terminal", phase: "direct", url: "https://x.example/", httpStatus: 503 } as const;
const descriptors = { type: "descriptors", tabId: 1, descriptors: [] } as const;
const localStatus = { type: "local-status", settings: {} as never, host: null, permissionGranted: false, jobs: [] } as const;

/** One valid sample per message of each channel. A message added to a type without a sample here does not compile. */
const POPUP: { readonly [T in PopupRequest["type"]]: { readonly request: Extract<PopupRequest, { type: T }>; readonly reply: PopupReply<T>; readonly wrong: unknown } } = {
  "list": { request: { type: "list", tabId: 1 }, reply: descriptors, wrong: { type: "descriptors" } },
  "rescan": { request: { type: "rescan", tabId: 1, retryFailed: true }, reply: { ...descriptors, reach: "needs-reload", reachable: false }, wrong: { ...descriptors, reach: "gone" } },
  "download-page": { request: { type: "download-page", tabId: 1, pageUrl: "https://site.example/", ids: [id] }, reply: descriptors, wrong: { ok: true } },
  "download": { request: { type: "download", streamId: id, choice }, reply: { type: "download-result", outcome: "listing-expired" }, wrong: { type: "download-result", outcome: "failed" } },
  "cancel": { request: { type: "cancel", streamId: id }, reply: { ok: true }, wrong: { ok: false } },
  "local-status": { request: { type: "local-status" }, reply: localStatus, wrong: { type: "local-status" } },
  "local-settings": { request: { type: "local-settings", patch: { quality: "720" } }, reply: localStatus, wrong: null },
  "local-download": { request: { type: "local-download", tabId: null, pageUrl: "https://site.example/" }, reply: localStatus, wrong: descriptors },
  "local-cancel": { request: { type: "local-cancel", id: "local-1" }, reply: localStatus, wrong: undefined },
  "export-save-diagnostics": { request: { type: "export-save-diagnostics", tabId: 1, pageUrl: "https://site.example/" }, reply: { ok: false }, wrong: { ok: "yes" } },
  "current-save-state": { request: { type: "current-save-state", tabId: 1, pageUrl: "https://site.example/", offer: { filename: "a.mov", url: "https://site.example/get" } },
    reply: { prompt: { id: "p", filename: "a.mov", tabId: 1, pageUrl: "https://site.example/" }, recovery: { stage: { kind: "resuming" }, bytesWritten: 1, bytesTotal: null }, saved: true },
    wrong: { saved: true } },
  "answer-repeat-save": { request: { type: "answer-repeat-save", id: "p", allow: false }, reply: { ok: true }, wrong: {} },
};

const BRIDGE: { readonly [T in BridgeToBackgroundMessage["type"]]: Extract<BridgeToBackgroundMessage, { type: T }> } = {
  "capture": { type: "capture", payload: { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: "https://cdn.example/a.mp4", pageUrl: "https://site.example/" } },
  "download-best-hotkey": { type: "download-best-hotkey", pageUrl: "https://site.example/" },
  "observed": { type: "observed", url: "https://cdn.example/a.mp4", requestType: "media", mime: "video/mp4" },
  "eme": { type: "eme", via: "encrypted", keySystem: "com.widevine.alpha", elementKey: "e1", elementSrc: null },
  "frame-active": { type: "frame-active", reason: "restore", url: "https://site.example/" },
};

const TO_ENGINE: { readonly [T in BackgroundToEngineMessage["type"]]: Extract<BackgroundToEngineMessage, { type: T }> } = {
  "welcome": { type: "welcome" },
  "start-job": { type: "start-job", streamId: id, descriptor: directDescriptor(), choice, resumeKey: "saved:abc" },
  "cancel-job": { type: "cancel-job", streamId: id },
  "release-output": { type: "release-output", blobUrl: "blob:chrome-extension://x/1" },
  "ack": { type: "ack", streamId: id },
  "requests-prepared": { type: "requests-prepared", requestId: 3 },
  "start-image": { type: "start-image", streamId: "image:1", url: "https://site.example/a.png" },
};

const FROM_ENGINE: { readonly [T in EngineToBackgroundMessage["type"]]: Extract<EngineToBackgroundMessage, { type: T }> } = {
  "engine-hello": { type: "engine-hello", protocol: 1, active: [{ streamId: id, progress: { bytesWritten: 1, bytesTotal: null, stage } }],
    outbox: [{ type: "complete", streamId: id, blobUrl: "blob:x", filename: "a.mp4", checksum: "c" }, { type: "failed", streamId: id, error }], retained: "saved:abc", idle: false },
  "transfer-http": { type: "transfer-http", streamId: id, observation: { host: "cdn.example", finalHost: null, status: 206, requestRange: null, contentRange: null,
    declaredBytes: null, ifRange: "none", acceptRanges: null, validator: null, hasETag: false, hasLastModified: false, elapsedMs: 3 } },
  "progress": { type: "progress", streamId: id, bytesWritten: 1, bytesTotal: 2, stage },
  "complete": { type: "complete", streamId: id, blobUrl: "blob:x", filename: "a.mp4", checksum: "c" },
  "failed": { type: "failed", streamId: id, error, retained: { bytes: 1, total: 2, expiresAt: 3 } },
  "prepare-requests": { type: "prepare-requests", requestId: 1, streamId: id, urls: ["https://cdn.example"] },
  "idle": { type: "idle" },
  "engine-fault": { type: "engine-fault", detail: "TypeError: x is not a function" },
  "retained-released": { type: "retained-released", streamId: id },
  "image-complete": { type: "image-complete", streamId: "image:1", blobUrl: "blob:chrome-extension://x/1", filename: "a.png" },
  "image-refused": { type: "image-refused", streamId: "image:1", received: "page" },
  "image-failed": { type: "image-failed", streamId: "image:1", error },
};

const BROADCAST: { readonly [T in BackgroundToPopupMessage["type"]]: Extract<BackgroundToPopupMessage, { type: T }> } = {
  "descriptors": descriptors,
  "repeat-save-changed": { type: "repeat-save-changed", tabId: 1, pageUrl: "https://site.example/" },
  "file-recovery-progress": { type: "file-recovery-progress", tabId: 1, pageUrl: "https://site.example/", progress: null },
  "file-save-problem": { type: "file-save-problem", tabId: 1, pageUrl: "https://site.example/", problem: null },
  "local-status": localStatus,
  "local-job": { type: "local-job", job: { id: "l", pageUrl: "https://site.example/", tabId: 1, phase: "failed", percent: null, downloadedBytes: null, totalBytes: null,
    speedBytesPerSec: null, etaSeconds: null, filename: null, failure: { code: "unknown", message: "ERROR: x", httpStatus: 403 } } },
  "job-progress": { type: "job-progress", streamId: id, bytesWritten: 1, bytesTotal: null, stage },
  "job-failed": { type: "job-failed", streamId: id, error },
  "job-complete": { type: "job-complete", streamId: id, path: "a.mp4" },
  "job-cancelled": { type: "job-cancelled", streamId: id },
};

/** The sample with one required field removed, or with its type changed, for each field it has besides `type`. */
function broken(sample: object): object[] {
  return Object.keys(sample).filter(key => key !== "type").map(key => {
    const copy = { ...sample } as Record<string, unknown>;
    copy[key] = typeof copy[key] === "string" ? 12345 : "wrong";
    return copy;
  });
}

describe("the message catalogue", () => {
  it.each(Object.values(POPUP))("popup request $request.type: the request, its reply and nothing else", ({ request, reply, wrong }) => {
    expect(parsePopupRequest(request)).toEqual(request);
    expect(parsePopupReply(request.type, reply)).toEqual(reply);
    expect(parsePopupReply(request.type, wrong)).toBeNull();
    expect(parsePopupReply(request.type, REQUEST_FAILED)).toBeNull();
    for (const bad of broken(request)) expect(parsePopupRequest(bad), JSON.stringify(bad)).toBeNull();
    // A popup request is never a page's, an engine's or a broadcast message.
    expect(parseBridgeRequest(request)).toBeNull();
    expect(parseEngineToBackground(request)).toBeNull();
    expect(parseBackgroundToEngine(request)).toBeNull();
  });

  it.each(Object.values(BRIDGE))("page message $type", message => {
    expect(parseBridgeRequest(message)).toEqual(message);
    for (const bad of broken(message)) expect(parseBridgeRequest(bad), JSON.stringify(bad)).toBeNull();
    expect(parsePopupRequest(message)).toBeNull();
  });

  it.each(Object.values(TO_ENGINE))("background to engine: $type", message => {
    expect(parseBackgroundToEngine(message)).toEqual(message);
    for (const bad of broken(message)) expect(parseBackgroundToEngine(bad), JSON.stringify(bad)).toBeNull();
    expect(parseEngineToBackground(message)).toBeNull();
  });

  it.each(Object.values(FROM_ENGINE))("engine to background: $type", message => {
    expect(parseEngineToBackground(message)).toEqual(message);
    for (const bad of broken(message)) expect(parseEngineToBackground(bad), JSON.stringify(bad)).toBeNull();
    expect(parseBackgroundToEngine(message)).toBeNull();
    expect(parsePopupRequest(message)).toBeNull();
  });

  it.each(Object.values(BROADCAST))("background to popup: $type", message => {
    expect(parseBroadcast(message)).toEqual(message);
    // "local-status" is also the name of the popup's request for it; every other broadcast is no request.
    if (message.type !== "local-status") expect(parsePopupRequest(message)).toBeNull();
  });

  it("knows no 'ready' message and nothing of the removed file connection, on any channel", () => {
    for (const type of ["ready", "desktop-connection-enabled", "read-linked-download", "file-download-url"]) {
      for (const parse of [parsePopupRequest, parseBridgeRequest, parseBroadcast, parseEngineToBackground, parseBackgroundToEngine]) {
        expect(parse({ type }), type).toBeNull();
        expect(parse({ type, tabId: 1, pageUrl: "https://site.example/", streamId: "stream-1" }), type).toBeNull();
      }
    }
  });

  it("takes nothing that is no message at all, on any channel", () => {
    for (const parse of [parsePopupRequest, parseBridgeRequest, parseBroadcast, parseEngineToBackground, parseBackgroundToEngine]) {
      for (const value of [null, undefined, "ready", 7, [], {}, { type: "nope" }]) expect(parse(value)).toBeNull();
    }
  });

  it("the engine checks the job it is handed: a descriptor is not any object", () => {
    const start = TO_ENGINE["start-job"];
    expect(parseBackgroundToEngine({ ...start, descriptor: {} })).toBeNull();
    expect(parseBackgroundToEngine({ ...start, descriptor: { ...start.descriptor, source: { kind: "direct-url", url: "x".repeat(9000) } } })).toBeNull();
    expect(parseBackgroundToEngine({ ...start, descriptor: { ...start.descriptor, source: { kind: "ftp" } } })).toBeNull();
    expect(parseBackgroundToEngine({ ...start, descriptor: { ...start.descriptor, tabId: "1" } })).toBeNull();
  });

  it("names its two ports, the view message and the engine's wake message", () => {
    expect([ENGINE_PORT, VIEW_PORT]).toEqual(["savemedia-engine", "savemedia-view"]);
    expect(parseViewMessage({ type: "view", tabId: 4 })).toEqual({ type: "view", tabId: 4 });
    expect(parseViewMessage({ type: "view", tabId: null })).toEqual({ type: "view", tabId: null });
    expect(parseViewMessage({ type: "view", tabId: "4" })).toBeNull();
    expect(isEngineWake({ type: "engine-connect" })).toBe(true);
    expect(isEngineWake({ type: "engine-connect", streamId: "x" })).toBe(false);
    expect(isEngineWake({ type: "start-job" })).toBe(false);
  });
});

describe("what the page's bridge forwards and what the background accepts", () => {
  const PAGE = "https://site.example/watch";
  const long = `https://cdn.example/${"a".repeat(8200)}`;
  const posted: unknown[] = [
    { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: "https://cdn.example/a.mp4" },
    { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: "https://cdn.example/v.mp4", audioUrl: "https://cdn.example/a.m4a" },
    // What a page adds on its own is not forwarded: the page address, a quality and a file name.
    { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: "https://ads.evil.example/a.mp4", pageUrl: "https://news.example/story",
      quality: { groupId: "x", height: 16384 }, filenameHint: "Interview.mp4" },
    { [MAIN_BRIDGE_TAG]: true, kind: "ad-media", adUrls: ["https://ads.example/c.mp4", 7, "javascript:alert(1)"], adVia: "vast" },
    { [MAIN_BRIDGE_TAG]: true, kind: "ad-media", adUrls: Array.from({ length: 500 }, (_, n) => `https://ads.example/${n}.mp4`), adVia: "hls-interstitial" },
    { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: long },
    { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: "https://cdn.example/a.mp4", audioUrl: 5 },
    { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: "blob:https://site.example/1" },
    { [MAIN_BRIDGE_TAG]: true, kind: "ad-media", adUrls: ["https://ads.example/c.mp4"], adVia: "made-up" },
    { [MAIN_BRIDGE_TAG]: true, kind: "eme", keySystem: "com.widevine.alpha" },
    { [MAIN_BRIDGE_TAG]: "yes", kind: "media-source", url: "https://cdn.example/a.mp4" },
    { kind: "media-source", url: "https://cdn.example/a.mp4" },
    null, "text", 4, [],
  ];

  it.each(posted.map((value, index) => [index, value] as const))("sample %i: every message the bridge forwards is one the background accepts", (_index, value) => {
    const forwarded = mainPayload(value, PAGE);
    if (forwarded === null) return;
    const message = { type: "capture", payload: forwarded };
    expect(parseBridgeRequest(message)).toEqual(message);
    // The page address is the document's, and nothing the page claimed about quality or names survives.
    expect(forwarded["pageUrl"]).toBe(PAGE);
    expect(Object.keys(forwarded).sort()).toEqual(expect.not.arrayContaining(["quality", "filenameHint"]));
  });

  it("forwards exactly the well-formed samples", () => {
    expect(posted.map(value => mainPayload(value, PAGE) !== null)).toEqual(
      [true, true, true, true, true, false, false, false, false, false, false, false, false, false, false, false]);
    expect(mainPayload(posted[3], PAGE)).toMatchObject({ adUrls: ["https://ads.example/c.mp4"] });
    expect((mainPayload(posted[4], PAGE) as { adUrls: string[] }).adUrls).toHaveLength(100);
  });

  it("the background refuses what the bridge would have refused, should a compromised page script send it directly", () => {
    for (const value of posted.slice(5)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      expect(parseBridgeRequest({ type: "capture", payload: { pageUrl: PAGE, ...(value as object) } }), JSON.stringify(value).slice(0, 80)).toBeNull();
    }
  });
});
