/**
 * Engine host entry point.
 *
 * Chromium loads this in the offscreen document and registers onMessage
 * listeners that drive the EngineRunner. Firefox uses the same runner through
 * an in-process background host because its engine runs in the background event
 * page instead of an offscreen document.
 */

import { isBackgroundToEngineMessage } from "../types/messages";
import { createInProcessEngineHost } from "./in-process-host";
import { readLinkedDownload } from "./linked-download";

const host = createInProcessEngineHost({
  sendToBackground: msg => {
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  },
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id === chrome.runtime.id && !sender.tab && msg && typeof msg === "object") {
    const request = msg as { type?: unknown; pageUrl?: unknown; filename?: unknown };
    if (request.type === "read-linked-download" && typeof request.pageUrl === "string"
      && typeof request.filename === "string") {
      void readLinkedDownload(request.pageUrl, request.filename).then(sendResponse, () => sendResponse(null));
      return true;
    }
  }
  if (!isBackgroundToEngineMessage(msg)) return false;
  host.handleMessage(msg);
  sendResponse({ ok: true });
  return false;
});

export {};
