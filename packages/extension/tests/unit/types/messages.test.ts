import { describe, it, expect } from "vitest";
import {
  FILE_SAVE_STAGES,
  HOTKEY_FEEDBACK_OUTCOMES,
  JOB_PHASES,
  MAIN_BRIDGE_TAG,
  parseBackgroundToEngine,
  parseBridgeRequest,
  parseBroadcast,
  parseEngineToBackground,
  parsePopupRequest,
} from "../../../src/types/messages";
import type {
  MainToBridgeMessage,
  BridgeToBackgroundMessage,
  BackgroundToContentMessage,
  PopupToBackgroundMessage,
  BackgroundToPopupMessage,
  BackgroundToEngineMessage,
  EngineToBackgroundMessage,
} from "../../../src/types/messages";
import type { StreamId, VariantId } from "@savemedia/core";

// Each channel has one validator, the parse function production code calls. These say whether it takes a value.
const isBridgeToBackgroundMessage = (value: unknown): boolean => parseBridgeRequest(value) !== null;
const isPopupToBackgroundMessage = (value: unknown): boolean => parsePopupRequest(value) !== null;
const isBackgroundToEngineMessage = (value: unknown): boolean => parseBackgroundToEngine(value) !== null;
const isEngineToBackgroundMessage = (value: unknown): boolean => parseEngineToBackground(value) !== null;
const isBackgroundToPopupMessage = (value: unknown): boolean => parseBroadcast(value) !== null;

describe("message types", () => {
  it("accepts bounded quality metadata and rejects malformed page hints", () => {
    const payload = { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: "https://cdn.example/clip.mp4", pageUrl: "https://player.example/" };
    expect(isBridgeToBackgroundMessage({ type: "capture", payload: { ...payload, quality: { groupId: "player-one", height: 720 } } })).toBe(true);
    for (const quality of [{ groupId: "", height: 720 }, { groupId: "one", height: -1 }, { groupId: "one", height: "720" }]) {
      expect(isBridgeToBackgroundMessage({ type: "capture", payload: { ...payload, quality } })).toBe(false);
    }
  });
  it("MAIN_BRIDGE_TAG is the agreed string discriminator", () => {
    expect(MAIN_BRIDGE_TAG).toBe("__savemedia");
  });

  it("MainToBridgeMessage carries the discriminator key set to true", () => {
    const msg: MainToBridgeMessage = {
      [MAIN_BRIDGE_TAG]: true,
      kind: "media-source",
      url: "https://x/clip.mp4",
      pageUrl: "https://x/",
    };
    expect(msg[MAIN_BRIDGE_TAG]).toBe(true);
    expect(msg.kind).toBe("media-source");
  });

  it("BridgeToBackgroundMessage 'capture' wraps a MainToBridgeMessage payload", () => {
    const wrap: BridgeToBackgroundMessage = {
      type: "capture",
      payload: {
        [MAIN_BRIDGE_TAG]: true,
        kind: "media-source",
        url: "https://x/clip.mp4",
        pageUrl: "https://x/",
      },
    };
    expect(wrap.type).toBe("capture");
    expect(wrap.payload[MAIN_BRIDGE_TAG]).toBe(true);
  });

  it("BridgeToBackgroundMessage carries page hotkey download-best requests", () => {
    const msg: BridgeToBackgroundMessage = {
      type: "download-best-hotkey",
      pageUrl: "https://example.com/watch",
    };
    expect(msg.type).toBe("download-best-hotkey");
  });

  it("runtime guards reject page commands disguised as capture payloads", () => {
    expect(isBridgeToBackgroundMessage({
      type: "capture",
      payload: {
        [MAIN_BRIDGE_TAG]: true,
        kind: "download-best-hotkey",
        pageUrl: "https://example.com/watch",
      },
    })).toBe(false);
    expect(isBridgeToBackgroundMessage({
      type: "download-best-hotkey",
      pageUrl: "https://example.com/watch",
    })).toBe(true);
  });

  it("capture payloads may carry a demuxed companion audioUrl (string only)", () => {
    const base = {
      [MAIN_BRIDGE_TAG]: true,
      kind: "media-source",
      url: "https://cdn.example/videoplayback?itag=137",
      pageUrl: "https://www.youtube.com/watch?v=1",
    };
    expect(isBridgeToBackgroundMessage({
      type: "capture",
      payload: { ...base, audioUrl: "https://cdn.example/videoplayback?itag=140" },
    })).toBe(true);
    expect(isBridgeToBackgroundMessage({
      type: "capture",
      payload: { ...base, audioUrl: 42 },
    })).toBe(false);
  });

  it("BackgroundToContentMessage asks a frame for its facts", () => {
    const msg: BackgroundToContentMessage = { type: "collect-facts", pointer: true, thumbnails: false };
    expect(msg.type).toBe("collect-facts");
  });

  it("accepts what the bridge reports about the browser and the page, within bounds", () => {
    const yes: unknown[] = [
      { type: "observed", url: "https://cdn.example/a.m3u8", requestType: "xmlhttprequest", mime: "application/vnd.apple.mpegurl" },
      { type: "eme", via: "license-request", keySystem: "com.widevine.alpha", elementKey: "v1", elementSrc: null },
      { type: "eme", via: "encrypted", keySystem: null, elementKey: null, elementSrc: "https://cdn.example/a.mp4" },
      { type: "frame-active", reason: "load", url: "https://example.com/watch" },
      { type: "frame-active", reason: "restore", url: "about:srcdoc" },
      { type: "download-best-hotkey", pageUrl: "https://example.com/watch" },
      { type: "capture", payload: { __savemedia: true, kind: "ad-media", url: null, pageUrl: "https://example.com/", adUrls: ["https://ads.example/a.mp4"], adVia: "vast" } },
    ];
    for (const message of yes) expect(isBridgeToBackgroundMessage(message), JSON.stringify(message)).toBe(true);
    const no: unknown[] = [
      { type: "ready" },
      { type: "observed", url: "https://cdn.example/a.m3u8", requestType: "image", mime: "" },
      { type: "observed", url: `https://cdn.example/${"a".repeat(9000)}`, requestType: "media", mime: "" },
      { type: "eme", via: "set-media-keys", keySystem: null, elementKey: "v1", elementSrc: null },
      { type: "frame-active", reason: "unload", url: "https://example.com/" },
      { type: "capture", payload: { __savemedia: true, kind: "eme", url: null, pageUrl: "https://example.com/", keySystem: "x" } },
      { type: "capture", payload: { __savemedia: true, kind: "media-element", url: "https://a.example/a.mp4", pageUrl: "https://example.com/" } },
      { type: "capture", payload: { __savemedia: true, kind: "ad-media", url: null, pageUrl: "x", adUrls: Array.from({ length: 101 }, () => "https://ads.example/a.mp4"), adVia: "vast" } },
      { type: "capture", payload: { __savemedia: true, kind: "ad-media", url: null, pageUrl: "x", adUrls: [], adVia: "other" } },
    ];
    for (const message of no) expect(isBridgeToBackgroundMessage(message), JSON.stringify(message)).toBe(false);
  });

  it("accepts image jobs and their answers between the background and the engine", () => {
    expect(isBackgroundToEngineMessage({ type: "start-image", streamId: "image:1", url: "https://site.example/card.png" })).toBe(true);
    expect(isBackgroundToEngineMessage({ type: "start-image", streamId: "image:1", url: "data:image/png;base64,AAAA" })).toBe(true);
    expect(isBackgroundToEngineMessage({ type: "start-image", streamId: "image:1", url: "file:///etc/passwd" })).toBe(false);
    // The origins inside the user's network the browser was answered from in the tab ride along, bounded.
    expect(isBackgroundToEngineMessage({ type: "start-image", streamId: "image:1", url: "http://192.168.1.10/cam.jpg", localOrigins: ["http://192.168.1.10"] })).toBe(true);
    expect(isBackgroundToEngineMessage({ type: "start-image", streamId: "image:1", url: "http://192.168.1.10/cam.jpg", localOrigins: "http://192.168.1.10" })).toBe(false);
    expect(isBackgroundToEngineMessage({ type: "start-image", streamId: "image:1", url: "http://192.168.1.10/cam.jpg",
      localOrigins: Array.from({ length: 65 }, (_item, index) => `http://10.0.0.${index}`) })).toBe(false);
    expect(isBackgroundToEngineMessage({ type: "start-image", streamId: "stream-1", url: "https://site.example/card.png" })).toBe(false);
    expect(isEngineToBackgroundMessage({ type: "image-complete", streamId: "image:1", blobUrl: "blob:chrome-extension://x/1", filename: "card.png" })).toBe(true);
    expect(isEngineToBackgroundMessage({ type: "image-complete", streamId: "image:1", blobUrl: "https://evil.example/x.exe", filename: "card.png" })).toBe(false);
    expect(isEngineToBackgroundMessage({ type: "image-refused", streamId: "image:1", received: "program" })).toBe(true);
    expect(isEngineToBackgroundMessage({ type: "image-refused", streamId: "image:1", received: "virus" })).toBe(false);
    expect(isEngineToBackgroundMessage({ type: "image-failed", streamId: "image:1", error: { code: "http_error", severity: "terminal" } })).toBe(true);
    // An error without the two fields every JobError has is not one.
    expect(isEngineToBackgroundMessage({ type: "image-failed", streamId: "image:1", error: { message: "x" } })).toBe(false);
  });

  it("a rescan may ask to check failed sources again, and the tab view carries the selection", () => {
    expect(isPopupToBackgroundMessage({ type: "rescan", tabId: 1, retryFailed: true })).toBe(true);
    expect(isPopupToBackgroundMessage({ type: "rescan", tabId: 1, retryFailed: "yes" })).toBe(false);
    expect(isBackgroundToPopupMessage({ type: "descriptors", tabId: 1, descriptors: [], failures: [], reachable: true, page: null, previews: {},
      selection: { state: "no-media", mainId: null, elementMain: false, mainName: null, cards: [] } })).toBe(true);
  });

  it("PopupToBackgroundMessage download carries streamId + choice", () => {
    const id = "stream-1" as StreamId;
    const variantId = "v1" as VariantId;
    const msg: PopupToBackgroundMessage = {
      type: "download",
      streamId: id,
      choice: {
        outputMode: "Original",
        filename: "clip.mp4",
        variantId,
        audioRenditionId: null,
      },
    };
    expect(msg.type).toBe("download");
    expect(msg.choice.filename).toBe("clip.mp4");
  });

  it("BackgroundToPopupMessage job-progress is well-typed", () => {
    const id = "stream-1" as StreamId;
    const msg: BackgroundToPopupMessage = {
      type: "job-progress",
      streamId: id,
      bytesWritten: 1024,
      bytesTotal: 4096,
      stage: { kind: "downloading" },
    };
    expect(msg.type === "job-progress" && msg.bytesWritten).toBe(1024);
    expect(msg.type === "job-progress" && msg.bytesTotal).toBe(4096);
  });

  it("BackgroundToEngineMessage start-job + cancel-job are exhaustive", () => {
    const id = "stream-1" as StreamId;
    const start: BackgroundToEngineMessage = {
      type: "start-job",
      streamId: id,
      descriptor: {
        id,
        tabId: 1,
        pageUrl: "https://x/",
        title: "clip",
        detectedAt: 1,
        source: { kind: "direct-url", url: "https://x/clip.mp4", headers: {} },
        protocol: "progressive-http",
        container: "mp4",
        codecs: { video: null, audio: null, subtitles: [] },
        variants: [],
        drm: null,
        capabilities: { directDownload: true, remuxableTo: ["mp4"] },
        confidence: { protocol: "guessed", container: "guessed", codecs: "guessed" },
      },
      choice: {
        outputMode: "Original",
        filename: "clip.mp4",
        variantId: null,
        audioRenditionId: null,
      },
    };
    const cancel: BackgroundToEngineMessage = { type: "cancel-job", streamId: id };
    expect(start.type).toBe("start-job");
    expect(cancel.type).toBe("cancel-job");
  });

  it("EngineToBackgroundMessage covers progress | complete | failed", () => {
    const id = "stream-1" as StreamId;
    const p: EngineToBackgroundMessage = {
      type: "progress",
      streamId: id,
      bytesWritten: 1,
      bytesTotal: 2,
      stage: { kind: "finalizing" },
    };
    const c: EngineToBackgroundMessage = {
      type: "complete",
      streamId: id,
      blobUrl: "blob:x",
      filename: "y.mp4",
      checksum: "abc",
    };
    const f: EngineToBackgroundMessage = {
      type: "failed",
      streamId: id,
      error: { code: "http_error", severity: "terminal", phase: "manifest", url: "", httpStatus: 404 },
    };
    expect(p.type).toBe("progress");
    expect(c.type).toBe("complete");
    expect(f.type).toBe("failed");
  });

  it("runtime guards accept the expected message families", () => {
    const id = "stream-1" as StreamId;
    expect(isPopupToBackgroundMessage({ type: "list", tabId: 7 })).toBe(true);
    // Save carries the streams of the card the user clicked.
    expect(isPopupToBackgroundMessage({ type: "download-page", tabId: 7, pageUrl: "https://site.test/", ids: ["stream-1", "stream-2"] })).toBe(true);
    expect(isPopupToBackgroundMessage({ type: "download-page", tabId: 7, pageUrl: "https://site.test/" })).toBe(true);
    expect(isPopupToBackgroundMessage({ type: "download-page", tabId: 7, pageUrl: "https://site.test/", ids: [3] })).toBe(false);
    expect(isBackgroundToPopupMessage({
      type: "job-complete",
      streamId: id,
      path: "video.mp4",
    })).toBe(true);
    expect(isBackgroundToEngineMessage({ type: "cancel-job", streamId: id })).toBe(true);
    expect(isEngineToBackgroundMessage({
      type: "progress",
      streamId: id,
      bytesWritten: 1,
      bytesTotal: null,
      stage: { kind: "retrying", attempt: 2, maxAttempts: 3, waitMs: 1000, httpStatus: 503, part: { index: 1, count: 4 } },
    })).toBe(true);
    expect(isEngineToBackgroundMessage({ type: "failed", streamId: id,
      error: { code: "server_busy", severity: "terminal" }, retained: { bytes: 1, total: 2, expiresAt: 3 } })).toBe(true);
    expect(isEngineToBackgroundMessage({ type: "prepare-requests", requestId: 1, streamId: id, urls: ["https://keys.example/k"] })).toBe(true);
    expect(isEngineToBackgroundMessage({ type: "prepare-requests", streamId: id, urls: ["https://keys.example/k"] })).toBe(false);
    expect(isEngineToBackgroundMessage({ type: "idle" })).toBe(true);
    expect(isEngineToBackgroundMessage({ type: "retained-released", streamId: id })).toBe(true);
  });
});

describe("what a save can end as, and what a named file's problem carries", () => {
  const cdm = { code: "cdm_required", severity: "terminal", keySystem: "com.widevine.alpha" };

  it("a cancel by the user is its own message and its own phase, without an error", () => {
    expect(isBackgroundToPopupMessage({ type: "job-cancelled", streamId: "s" })).toBe(true);
    expect(isBackgroundToPopupMessage({ type: "job-cancelled" })).toBe(false);
    expect(JOB_PHASES).toEqual(["queued", "active", "complete", "failed", "cancelled"]);
    expect(isBackgroundToPopupMessage({ type: "descriptors", tabId: 1, descriptors: [], statuses: { s: { phase: "cancelled" } } })).toBe(true);
    expect(isBackgroundToPopupMessage({ type: "descriptors", tabId: 1, descriptors: [], statuses: { s: { phase: "aborted" } } })).toBe(false);
  });

  it("a named file's problem carries the error itself, or null when the save never started, and no ready-made text", () => {
    const base = { type: "file-save-problem", tabId: 1, pageUrl: "https://site.example/" };
    expect(isBackgroundToPopupMessage({ ...base, problem: null })).toBe(true);
    for (const stage of FILE_SAVE_STAGES) {
      expect(isBackgroundToPopupMessage({ ...base, problem: { filename: "Clip.mov", stage, error: cdm } })).toBe(true);
      expect(isBackgroundToPopupMessage({ ...base, problem: { filename: "Clip.mov", stage, error: null } })).toBe(true);
    }
    expect(isBackgroundToPopupMessage({ ...base, problem: { filename: "Clip.mov", stage: "file connection", error: null } })).toBe(false);
    expect(isBackgroundToPopupMessage({ ...base, problem: { filename: "Clip.mov", stage: "checking" } })).toBe(false);
    expect(isBackgroundToPopupMessage({ ...base, problem: { filename: "Clip.mov", stage: "checking", error: { title: "prose" } } })).toBe(false);
    // The old shape, with a title and a body written in the background, is no longer a problem.
    expect(isBackgroundToPopupMessage({ ...base, problem: { filename: "Clip.mov", stage: "checking", title: "t", body: "b", code: "x" } })).toBe(false);
  });

  it("Save another copy carries the user's answer with it; progress may say when its stage began", () => {
    const choice = { outputMode: "Original", filename: "clip.mp4", variantId: null, audioRenditionId: null };
    expect(isPopupToBackgroundMessage({ type: "download", streamId: "s", choice, allowRepeat: true })).toBe(true);
    expect(isPopupToBackgroundMessage({ type: "download", streamId: "s", choice, allowRepeat: "yes" })).toBe(false);
    expect(isPopupToBackgroundMessage({ type: "download-page", tabId: 1, pageUrl: "https://site.example/", allowRepeat: true })).toBe(true);
    expect(isBackgroundToPopupMessage({ type: "job-progress", streamId: "s", bytesWritten: 1, bytesTotal: null, stage: { kind: "downloading" }, stageSince: 5 })).toBe(true);
  });

  it("an Alt+S result is one of the toast's outcomes, the open question and the cancel among them", () => {
    expect(HOTKEY_FEEDBACK_OUTCOMES).toEqual(["preparing", "started", "delegated", "complete", "no-media", "waiting", "asked", "failed", "cancelled"]);
  });
});

describe("message guards reject malformed payloads", () => {
  it("popup local-settings patches must use known values", () => {
    expect(isPopupToBackgroundMessage({ type: "local-settings", patch: { quality: "720", cookies: "edge" } })).toBe(true);
    expect(isPopupToBackgroundMessage({ type: "local-settings", patch: { quality: "4k" } })).toBe(false);
    expect(isPopupToBackgroundMessage({ type: "local-settings", patch: { enabled: "yes" } })).toBe(false);
    expect(isPopupToBackgroundMessage({ type: "local-settings" })).toBe(false);
  });

  it("progress messages need numeric byte counts, a nullable total and a known stage", () => {
    const stage = { kind: "downloading" };
    expect(isEngineToBackgroundMessage({ type: "progress", streamId: "s", bytesWritten: "1", bytesTotal: null, stage })).toBe(false);
    expect(isBackgroundToPopupMessage({ type: "job-progress", streamId: "s", bytesWritten: 1, bytesTotal: undefined, stage })).toBe(false);
    // English prose is not a stage.
    expect(isEngineToBackgroundMessage({ type: "progress", streamId: "s", bytesWritten: 1, bytesTotal: null, stage: "Resuming automatically in 2s" })).toBe(false);
    expect(isEngineToBackgroundMessage({ type: "progress", streamId: "s", bytesWritten: 1, bytesTotal: null, stage: { kind: "paused" } })).toBe(false);
    expect(isEngineToBackgroundMessage({ type: "prepare-requests", streamId: "s", urls: ["blob:x"] })).toBe(false);
  });

  it("capture payloads reject unknown kinds and addresses that are not strings", () => {
    const payload = { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: null, pageUrl: "https://x/" };
    expect(isBridgeToBackgroundMessage({ type: "capture", payload })).toBe(true);
    expect(isBridgeToBackgroundMessage({ type: "capture", payload: { ...payload, kind: "webrtc" } })).toBe(false);
    expect(isBridgeToBackgroundMessage({ type: "capture", payload: { ...payload, adUrls: [1] } })).toBe(false);
    expect(isBridgeToBackgroundMessage({ type: "capture", payload: { ...payload, audioUrl: 7 } })).toBe(false);
    expect(isBridgeToBackgroundMessage({ type: "capture", payload: { ...payload, [MAIN_BRIDGE_TAG]: "true" } })).toBe(false);
  });
});
