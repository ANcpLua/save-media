/**
 * Engine host entry point.
 *
 * Chromium loads this in the offscreen document. Firefox loads it alongside
 * the background event page. Both contexts get the same code path: register
 * onMessage listeners that drive the EngineRunner. The actual DownloadJob
 * implementation comes from engine/download.ts.
 */

import { createEngineRunner } from "./runner";
import { downloadJob } from "./download";
import type { BackgroundToEngineMessage } from "../types/messages";

const runner = createEngineRunner({
  runtime: {
    sendMessage: (msg, cb) => {
      chrome.runtime.sendMessage(msg, () => {
        void chrome.runtime.lastError;
        cb?.(undefined);
      });
    },
  },
  downloadJob,
});

chrome.runtime.onMessage.addListener((msg: BackgroundToEngineMessage, _sender, sendResponse) => {
  if (msg.type === "start-job") {
    void runner.start(msg.streamId, msg.descriptor, msg.choice);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "cancel-job") {
    runner.cancel(msg.streamId);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

export {};
