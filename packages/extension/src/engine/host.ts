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

const host = createInProcessEngineHost({
  sendToBackground: msg => {
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  },
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isBackgroundToEngineMessage(msg)) return false;
  host.handleMessage(msg);
  sendResponse({ ok: true });
  return false;
});

export {};
