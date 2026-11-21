// MUST be the first import. Shims window→globalThis so transitively
// loaded videojs parsers (m3u8-parser, mpd-parser) don't crash the SW
// at module-load with `ReferenceError: window is not defined`.
import "../sw-globals-polyfill";

import {
  isBackgroundToEngineMessage,
  isBridgeToBackgroundMessage,
  isEngineToBackgroundMessage,
  isPopupToBackgroundMessage,
} from "../types/messages";
import type {
  BackgroundToEngineMessage,
  BackgroundToPopupMessage,
  DiscoveredMedia,
  EngineToBackgroundMessage,
  FileSaveState,
  PopupToBackgroundMessage,
} from "../types/messages";
import { createRouter } from "./router";
import { refreshDirectSource } from "./refresh-direct";
import { saveVerifiedDownload } from "./browser-download";
import { createCaptureHandler } from "./capture";
import { createDiagnosticFetch } from "./diagnostic-fetch";
import { discoverPageMediaForTab, downloadBestForTab, handleFileConnectionChoice, registerDownloadBestCommand, type DownloadBestDeps } from "./download-best";
import { createHotkeyJobs } from "./hotkey-jobs";
import { createRefererMirror, registerNetworkCapture } from "./network-capture";
import { handleInstalled } from "./installed";
import { ensureEngineHost } from "../platform/processor-host";
import { createInProcessEngineHost } from "../engine/in-process-host";
import { consoleLogger } from "../util/logger";
import { createNativeHostClient } from "../native/host-client";
import { createLocalDownloader } from "../native/local-downloader";
import type { BackgroundToContentMessage, HotkeyFeedbackOutcome, LocalJobView } from "../types/messages";

declare const __BROWSER__: "chromium" | "firefox";

const logger = consoleLogger("bg");

let router: ReturnType<typeof createRouter>;

const firefoxEngineHost = __BROWSER__ === "firefox"
  ? createInProcessEngineHost({
    sendToBackground: msg => {
      void handleEngineMessage(msg);
    },
  })
  : null;

router = createRouter({
  runtime: {
    sendMessage: (msg, cb) => {
      if (firefoxEngineHost && isEngineControlMessage(msg)) {
        firefoxEngineHost.handleMessage(msg);
        cb?.({ ok: true });
        return;
      }
      chrome.runtime.sendMessage(msg, () => {
        void chrome.runtime.lastError;
        cb?.(undefined);
      });
    },
  },
  downloads: {
    download: opts => saveVerifiedDownload(chrome.downloads, opts as chrome.downloads.DownloadOptions),
  },
  ensureEngineHost,
  refreshDirectSource: (descriptor, signal) => refreshDirectSource({
    tabs: chrome.tabs,
    discover: async (tabId, pageUrl) => (await discoverPageMediaForTab(downloadBestDeps, tabId, pageUrl, pageUrl, true))?.media ?? null,
    list: tabId => router.listDescriptors(tabId),
  }, descriptor, signal),
  releaseBlob: blobUrl => {
    if (firefoxEngineHost) URL.revokeObjectURL(blobUrl);
    else chrome.runtime.sendMessage({ type: "release-output", blobUrl } satisfies BackgroundToEngineMessage,
      () => void chrome.runtime.lastError);
  },
  logger,
});

const handleCapture = createCaptureHandler({
  fetchFn: createDiagnosticFetch(chrome.webRequest, chrome.runtime.getURL("").replace(/\/$/, "")),
  mirrorReferer: createRefererMirror(chrome.declarativeNetRequest, new URL(chrome.runtime.getURL("")).host),
  onDescriptor: (tabId, descriptor) => {
    const added = router.addDescriptor(tabId, descriptor);
    if (added) {
      updateBadge(tabId);
      broadcastDescriptors(tabId);
    }
  },
  onFailure: (tabId, failure) => {
    router.setDiscoveryFailure(tabId, failure);
    broadcastDescriptors(tabId);
  },
  onProbeSuccess: (tabId, url) => {
    if (router.clearDiscoveryFailure(tabId, url)) broadcastDescriptors(tabId);
  },
  logger,
});

const localDownloader = createLocalDownloader({
  client: createNativeHostClient({
    connectNative: name => chrome.runtime.connectNative(name),
    lastError: () => chrome.runtime.lastError as { readonly message?: string } | undefined,
  }),
  storage: {
    get: key => chrome.storage.local.get(key),
    set: items => chrome.storage.local.set(items),
  },
  permissions: {
    contains: perm => chrome.permissions.contains({ permissions: [...perm.permissions] as chrome.runtime.ManifestPermission[] }),
  },
  env: { browser: __BROWSER__, userAgent: navigator.userAgent },
  onJobUpdate: job => broadcastLocalJob(job),
});

function broadcastLocalJob(job: LocalJobView): void {
  const msg: BackgroundToPopupMessage = { type: "local-job", job };
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  if (job.tabId === null) return;
  if (job.phase === "complete") {
    notifyTab(job.tabId, "complete", job.filename ?? "Download finished");
  } else if (job.phase === "failed" && job.failure) {
    notifyTab(job.tabId, "failed", job.failure.message || job.failure.code);
  }
}

function notifyTab(tabId: number, outcome: HotkeyFeedbackOutcome, detail: string): void {
  const msg: BackgroundToContentMessage = { type: "hotkey-feedback", outcome, detail };
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, () => void chrome.runtime.lastError);
}

const hotkeyJobs = createHotkeyJobs();

async function isOnPage(tabId: number, pageUrl: string): Promise<boolean> {
  return chrome.tabs.get(tabId).then(tab => tab.url === pageUrl, () => false);
}

const downloadBestDeps: DownloadBestDeps = {
  tabs: {
    query: queryInfo => chrome.tabs.query(queryInfo),
    sendMessage: (tabId, msg, cb) => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, cb),
    isOnPage,
  },
  runtime: {
    lastError: () => chrome.runtime.lastError,
    sendMessage: (msg, cb) => chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
      cb?.();
    }),
  },
  router,
  handleCapture,
  generateDownload: async (tabId, pageUrl, { filename, linkedPage }) => {
    try {
      if (!await isOnPage(tabId, pageUrl)) return null;
      const message: BackgroundToContentMessage = { type: "generate-download-url", pageUrl, filename };
      let source: DiscoveredMedia | null;
      if (linkedPage && __BROWSER__ === "chromium") {
        await ensureEngineHost();
        source = await chrome.runtime.sendMessage({ type: "read-linked-download", pageUrl: linkedPage, filename });
      } else {
        source = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
      }
      return source?.filenameHint === filename && typeof source.url === "string"
        && await isOnPage(tabId, pageUrl) ? source : null;
    } catch { return null; }
  },
  rememberFileSaveProblem: async (tabId, pageUrl, problem) => {
    const msg = { type: "file-save-problem", tabId, pageUrl, problem } satisfies BackgroundToPopupMessage;
    await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => undefined);
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  },
  showHotkeyFeedback,
  localFallback: (pageUrl, tabId) => localDownloader.startFallback(pageUrl, tabId),
  trackHotkeyJob: (streamId, tabId) => hotkeyJobs.track(streamId, tabId),
};

const FEEDBACK_BADGES: Record<HotkeyFeedbackOutcome, { text: string; color: string }> = {
  "preparing": { text: "…", color: "#2563eb" },
  "retrying": { text: "↻", color: "#f97316" },
  "started": { text: "↓", color: "#16a34a" },
  "delegated": { text: "⇣", color: "#2563eb" },
  "complete": { text: "✓", color: "#16a34a" },
  "no-media": { text: "∅", color: "#6b7280" },
  "failed": { text: "✗", color: "#dc2626" },
};

function showHotkeyFeedback(tabId: number, outcome: HotkeyFeedbackOutcome, detail: string): void {
  const badge = FEEDBACK_BADGES[outcome];
  chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => undefined);
  chrome.action.setBadgeText({ tabId, text: badge.text }).catch(() => undefined);
  setTimeout(() => updateBadge(tabId), 2_000);
  notifyTab(tabId, outcome, detail);
}

function isEngineControlMessage(msg: unknown): msg is BackgroundToEngineMessage {
  return isBackgroundToEngineMessage(msg);
}

// Fires once per store update, before any other event of the new version.
chrome.runtime.onInstalled.addListener(details => {
  void handleInstalled(details, {
    storage: {
      getAll: () => chrome.storage.local.get(null),
      set: items => chrome.storage.local.set(items),
      remove: keys => chrome.storage.local.remove([...keys]),
    },
    permissions: {
      contains: perm => chrome.permissions.contains({ permissions: [...perm.permissions] as chrome.runtime.ManifestPermission[] }),
    },
    log: message => logger.info(message),
  }, chrome.runtime.getManifest().version);
});

function clearTab(tabId: number): void {
  handleCapture.clearTab(tabId);
  router.clearTab(tabId);
}
chrome.tabs.onRemoved.addListener(clearTab);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") clearTab(tabId);
});

registerNetworkCapture(handleCapture);

registerDownloadBestCommand(chrome.commands, downloadBestDeps);

function updateBadge(tabId: number): void {
  const count = router.listDescriptors(tabId).length;
  const text = count > 0 ? String(count) : "";
  // Tab can vanish between an in-flight async classify and this badge
  // update. chrome.action.setBadge* rejects with "No tab with id: N";
  // we don't care — the tab is gone, the badge is moot. Catch and drop.
  chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => undefined);
  }
}

function broadcastDescriptors(tabId: number): void {
  const msg = router.snapshot(tabId);
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
}

chrome.runtime.onMessage.addListener((
  msg: unknown,
  sender,
  sendResponse,
) => {
  if (isBridgeToBackgroundMessage(msg)) {
    if (msg.type === "download-best-hotkey") {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) void downloadBestForTab(downloadBestDeps, tabId, msg.pageUrl).catch(() => {
        showHotkeyFeedback(tabId, "failed", "Couldn’t start the download. Try again.");
      });
      return false;
    }

    if (msg.type === "capture") {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) void handleCapture(tabId, msg);
      return false;
    }

    return false;
  }

  if (isPopupToBackgroundMessage(msg)) {
    if (msg.type === "file-connection-choice") {
      const popup = chrome.runtime.getURL("src/popup/index.html");
      if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/, 1)[0] !== popup) return false;
      void applyFileConnectionChoice(msg)
        .then(() => sendResponse(router.snapshot(msg.tabId)), () => sendResponse(null));
      return true;
    }
    if (msg.type === "download-page") {
      void downloadBestForTab(downloadBestDeps, msg.tabId, msg.pageUrl, true)
        .then(() => sendResponse(router.snapshot(msg.tabId)), () => sendResponse(router.snapshot(msg.tabId)));
      return true;
    }
    if (msg.type === "rescan") {
      // A failed or unreachable rescan must not erase the previous error.
      // Successful probes clear their own failures through onProbeSuccess.
      void discoverPageMediaForTab(downloadBestDeps, msg.tabId, "")
        .then(() => sendResponse(router.snapshot(msg.tabId)))
        .catch(() => sendResponse(router.snapshot(msg.tabId)));
      return true;
    }
    if (msg.type.startsWith("local-")) {
      void handleLocalPopupMessage(msg).then(sendResponse);
      return true;
    }
    void router.handlePopupMessage(msg).then(response => {
      if (response) sendResponse(response);
    });
    return true; // keep channel open
  }

  if (isEngineToBackgroundMessage(msg)) {
    void handleEngineMessage(msg);
    return false;
  }

  return false;
});

async function applyFileConnectionChoice(msg: Extract<PopupToBackgroundMessage, { type: "file-connection-choice" }>): Promise<void> {
  const request = { type: "file-save-state", pageUrl: msg.pageUrl } satisfies BackgroundToContentMessage;
  const state: FileSaveState | null = await chrome.tabs.sendMessage(msg.tabId, request, { frameId: 0 });
  await handleFileConnectionChoice(downloadBestDeps, msg, state);
}

// Every local-* request answers with the full status so the popup has one
// code path to render from.
async function handleLocalPopupMessage(msg: PopupToBackgroundMessage): Promise<BackgroundToPopupMessage> {
  switch (msg.type) {
    case "local-settings":
      await localDownloader.updateSettings(msg.patch);
      break;
    case "local-download":
      await localDownloader.start(msg.pageUrl, msg.tabId);
      break;
    case "local-cancel":
      localDownloader.cancel(msg.id);
      break;
    default:
      break;
  }
  return { type: "local-status", ...(await localDownloader.status()) };
}

async function handleEngineMessage(msg: EngineToBackgroundMessage): Promise<void> {
  const forward = await router.handleEngineMessage(msg);
  if (forward) {
    chrome.runtime.sendMessage(forward, () => void chrome.runtime.lastError);
    const feedback = hotkeyJobs.feedbackFor(forward);
    if (feedback) showHotkeyFeedback(feedback.tabId, feedback.outcome, feedback.detail);
  }
}
