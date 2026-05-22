import {
  classify,
  dispatch,
  type StreamDescriptor,
  type UserChoice,
  type JobError,
} from "@savemedia/core";
import type {
  BridgeToBackgroundMessage,
  PopupToBackgroundMessage,
  BackgroundToPopupMessage,
  BackgroundToEngineMessage,
  EngineToBackgroundMessage,
} from "../types/messages";
import { ensureEngineHost } from "../platform/processor-host/chromium";

interface TabState {
  readonly descriptors: Map<string, StreamDescriptor>;
}

const tabs = new Map<number, TabState>();
const jobs = new Map<StreamDescriptor["id"], { descriptor: StreamDescriptor; choice: UserChoice }>();

function getTab(tabId: number): TabState {
  let state = tabs.get(tabId);
  if (!state) {
    state = { descriptors: new Map() };
    tabs.set(tabId, state);
  }
  return state;
}

chrome.tabs.onRemoved.addListener(tabId => tabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) tabs.delete(tabId);
});

async function handleCapture(tabId: number, msg: Extract<BridgeToBackgroundMessage, { type: "capture" }>): Promise<void> {
  const cap = msg.payload;
  if (!cap.url && cap.kind !== "eme") return;

  let headers: Record<string, string> = cap.responseHeaders ? { ...cap.responseHeaders } : {};
  let bodyBytes: Uint8Array | null = null;
  let manifestText: string | null = null;

  if (cap.url) {
    try {
      const r = await fetch(cap.url, { credentials: "include" });
      r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const ct = headers["content-type"] ?? "";
      if (/(mpegurl|dash\+xml|xml|text)/i.test(ct) || /\.(m3u8|mpd)(\?|$)/i.test(cap.url)) {
        manifestText = await r.text();
      } else {
        const buf = await r.clone().arrayBuffer();
        bodyBytes = new Uint8Array(buf.slice(0, 4096));
      }
    } catch {
      // CORS / network — proceed with what we have.
    }
  }

  if (cap.kind === "eme" && cap.keySystem) {
    headers["x-savemedia-eme-keysystem"] = cap.keySystem;
  }

  const descriptor = await classify({
    tabId,
    pageUrl: cap.pageUrl,
    url: cap.url ?? cap.pageUrl,
    headers,
    bodyBytes,
    manifestText,
  });

  const key = `${descriptor.source.kind}:${descriptor.protocol}:${cap.url ?? cap.pageUrl}`;
  const state = getTab(tabId);
  if (!state.descriptors.has(key)) {
    state.descriptors.set(key, descriptor);
    updateBadge(tabId);
  }
}

function updateBadge(tabId: number): void {
  const count = getTab(tabId).descriptors.size;
  const text = count > 0 ? String(count) : "";
  void chrome.action.setBadgeText({ tabId, text });
  if (count > 0) void chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
}

function findDescriptor(streamId: StreamDescriptor["id"]): StreamDescriptor | null {
  for (const state of tabs.values()) {
    for (const d of state.descriptors.values()) if (d.id === streamId) return d;
  }
  return null;
}

async function startDownload(streamId: StreamDescriptor["id"], choice: UserChoice): Promise<JobError | null> {
  const descriptor = findDescriptor(streamId);
  if (!descriptor) {
    return { code: "manifest_404", severity: "terminal", url: "", httpStatus: 0 };
  }

  const plan = dispatch(descriptor, choice);

  if (plan.kind === "refuse") {
    return drmRefusalToError(plan.reason, descriptor);
  }

  if (plan.kind === "direct") {
    try {
      await chrome.downloads.download({
        url: plan.url,
        filename: plan.filename,
        conflictAction: "uniquify",
      });
      return null;
    } catch (err) {
      return {
        code: "native_sink_io_error",
        severity: "terminal",
        errno: String((err as Error)?.message ?? err),
        path: plan.filename,
      };
    }
  }

  jobs.set(streamId, { descriptor, choice });
  await ensureEngineHost();
  const engineMsg: BackgroundToEngineMessage = { type: "start-job", streamId, descriptor, choice };
  chrome.runtime.sendMessage(engineMsg, () => void chrome.runtime.lastError);
  return null;
}

function drmRefusalToError(reason: NonNullable<StreamDescriptor["drm"]>["reason"], d: StreamDescriptor): JobError {
  const drm = d.drm;
  switch (reason) {
    case "encrypted_media_detected":
      return { code: "encrypted_media_detected", severity: "terminal", detectedVia: drm?.detectedVia ?? [], keySystem: drm?.keySystem ?? null };
    case "cdm_required":
      return { code: "cdm_required", severity: "terminal", keySystem: drm?.keySystem ?? "unknown" };
    case "clear_segments_unavailable":
      return { code: "clear_segments_unavailable", severity: "terminal", manifestUrl: d.pageUrl };
    case "license_bound_stream":
      return { code: "license_bound_stream", severity: "terminal", keyUri: "", httpStatus: 0 };
    case "clearkey_deferred":
      return { code: "clearkey_deferred", severity: "terminal", manifestUrl: d.pageUrl };
  }
}

chrome.runtime.onMessage.addListener((
  msg: BridgeToBackgroundMessage | PopupToBackgroundMessage | EngineToBackgroundMessage,
  sender,
  sendResponse,
) => {
  if ("type" in msg && msg.type === "capture") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) void handleCapture(tabId, msg);
    return false;
  }

  if (msg.type === "list") {
    const state = tabs.get(msg.tabId);
    const descriptors = state ? Array.from(state.descriptors.values()) : [];
    const response: BackgroundToPopupMessage = { type: "descriptors", tabId: msg.tabId, descriptors };
    sendResponse(response);
    return false;
  }

  if (msg.type === "download") {
    void startDownload(msg.streamId, msg.choice).then(err => {
      if (err) {
        const failMsg: BackgroundToPopupMessage = { type: "job-failed", streamId: msg.streamId, error: err };
        chrome.runtime.sendMessage(failMsg, () => void chrome.runtime.lastError);
      }
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "cancel") {
    jobs.delete(msg.streamId);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "progress") {
    const fwd: BackgroundToPopupMessage = {
      type: "job-progress",
      streamId: msg.streamId,
      bytesWritten: msg.bytesWritten,
      bytesTotal: msg.bytesTotal,
      phase: msg.phase,
    };
    chrome.runtime.sendMessage(fwd, () => void chrome.runtime.lastError);
    return false;
  }

  if (msg.type === "complete") {
    jobs.delete(msg.streamId);
    void chrome.downloads.download({ url: msg.blobUrl, filename: msg.filename, conflictAction: "uniquify" });
    const fwd: BackgroundToPopupMessage = { type: "job-complete", streamId: msg.streamId, path: msg.filename };
    chrome.runtime.sendMessage(fwd, () => void chrome.runtime.lastError);
    return false;
  }

  if (msg.type === "failed") {
    jobs.delete(msg.streamId);
    const fwd: BackgroundToPopupMessage = { type: "job-failed", streamId: msg.streamId, error: msg.error };
    chrome.runtime.sendMessage(fwd, () => void chrome.runtime.lastError);
    return false;
  }

  if (msg.type === "ready") {
    return false;
  }

  return false;
});
