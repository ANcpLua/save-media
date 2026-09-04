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
  EngineToBackgroundMessage,
  PopupToBackgroundMessage,
} from "../types/messages";
import { createRouter } from "./router";
import { createCaptureHandler } from "./capture";
import { downloadBestForTab, registerDownloadBestCommand, type DownloadBestDeps } from "./download-best";
import { registerNetworkCapture } from "./network-capture";
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
    download: async (opts) => chrome.downloads.download(opts as chrome.downloads.DownloadOptions),
  },
  ensureEngineHost,
  logger,
});

const handleCapture = createCaptureHandler({
  fetchFn: (url, init) => fetch(url, init),
  onDescriptor: (tabId, descriptor) => {
    const added = router.addDescriptor(tabId, descriptor);
    if (added) {
      updateBadge(tabId);
      broadcastDescriptors(tabId);
    }
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
    contains: perm => chrome.permissions.contains({ permissions: [...perm.permissions] }),
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
  chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
}

const downloadBestDeps: DownloadBestDeps = {
  tabs: {
    query: queryInfo => chrome.tabs.query(queryInfo),
    sendMessage: (tabId, msg, cb) => chrome.tabs.sendMessage(tabId, msg, cb),
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
  showHotkeyFeedback,
  localFallback: (pageUrl, tabId) => localDownloader.startFallback(pageUrl, tabId),
};

const FEEDBACK_BADGES: Record<HotkeyFeedbackOutcome, { text: string; color: string }> = {
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

chrome.tabs.onRemoved.addListener(tabId => router.clearTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) router.clearTab(tabId);
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
  const msg: BackgroundToPopupMessage = {
    type: "descriptors",
    tabId,
    descriptors: router.listDescriptors(tabId),
  };
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
      if (tabId !== undefined) void downloadBestForTab(downloadBestDeps, tabId, msg.pageUrl);
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
  }
}
