/**
 * Engine host entry point.
 *
 * Chromium loads this in the offscreen document and registers onMessage
 * listeners that drive the EngineRunner. Firefox uses the same runner through
 * an in-process background host because its engine runs in the background event
 * page instead of an offscreen document.
 */

import type { BackgroundToEngineMessage } from "../types/messages";
import { createInProcessEngineHost } from "./in-process-host";

const host = createInProcessEngineHost({
  sendToBackground: msg => {
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  },
});

chrome.runtime.onMessage.addListener((msg: BackgroundToEngineMessage, _sender, sendResponse) => {
  if (msg.type === "start-job" || msg.type === "cancel-job") {
    host.handleMessage(msg);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

export {};
