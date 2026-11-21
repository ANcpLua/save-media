import { saveVerifiedDownload } from "./browser-download";
import { namedFileIdentity, reserveSave } from "./session-saves";
import { ensureEngineHost } from "../platform/processor-host";
import type { RelayResult } from "../engine/relay-transfer";
import type { DiscoveredMedia, FileDownloadOffer, FileRelayStatus, FileRelayStatusMessage } from "../types/messages";

type SaveResult = {saved: string} | {error: string; code?: string} | null;
const pending = new Map<string, Promise<SaveResult>>();
const latest = new Map<number, FileRelayStatusMessage>();

export function relaySnapshot(tabId: number, pageUrl: string): FileRelayStatus | undefined {
  const message = latest.get(tabId);
  return message?.pageUrl === pageUrl ? message.status : undefined;
}

export function clearRelayStatus(tabId: number, pageUrl?: string): void {
  if (!pageUrl || latest.get(tabId)?.pageUrl === pageUrl) latest.delete(tabId);
}

export function saveThroughRelay(tabId: number, pageUrl: string, offer: FileDownloadOffer, source: DiscoveredMedia,
  stillEligible: () => Promise<boolean>, onProgress: (id: string, state: FileRelayStatus | null) => void): Promise<SaveResult> {
  const key = JSON.stringify([tabId, pageUrl, offer.filename, offer.linkedPage]);
  const existing = pending.get(key);
  if (existing) return existing;

  const requestId = crypto.randomUUID();
  function report(status: FileRelayStatus) {
    const msg: FileRelayStatusMessage = {type: "file-relay-status", tabId, pageUrl, status};
    latest.set(tabId, msg);
    onProgress(requestId, status.phase === "saving" ? status : null);
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    chrome.tabs.sendMessage(tabId, msg, {frameId: 0}, () => void chrome.runtime.lastError);
  }
  async function save(): Promise<SaveResult> {
    if (!await stillEligible()) return {error: "The file is no longer available on this page."};
    const permit = await reserveSave(namedFileIdentity(pageUrl, offer), tabId, pageUrl, offer.filename);
    if (!permit) return null;
    let saved = false;
    const engineUrl = chrome.runtime.getURL("src/engine/offscreen.html");
    const receiveProgress = (msg: {type?: string; requestId?: string; stage?: string; bytesWritten?: number; bytesTotal?: number | null} | null, sender: chrome.runtime.MessageSender) => {
      if (sender.url !== engineUrl || msg?.type !== "relay-progress" || msg.requestId !== requestId || typeof msg.stage !== "string"
        || typeof msg.bytesWritten !== "number" || !(typeof msg.bytesTotal === "number" || msg.bytesTotal === null)) return;
      report({filename: offer.filename, phase: "saving", stage: msg.stage,
        bytesWritten: msg.bytesWritten, bytesTotal: msg.bytesTotal});
    };
    chrome.runtime.onMessage.addListener(receiveProgress);
    try {
      chrome.tabs.sendMessage(tabId, {type: "hotkey-feedback", outcome: "preparing", detail: "Connecting to secure relay"},
        {frameId: 0}, () => void chrome.runtime.lastError);
      report({filename: offer.filename, phase: "saving", stage: "Connecting to secure relay"});
      await ensureEngineHost();
      const file: RelayResult | undefined = await chrome.runtime.sendMessage({
        type: "relay-file", requestId, tabId, filename: offer.filename, source, referrer: offer.linkedPage ?? pageUrl,
      }).catch(() => undefined);
      if (!file) return {error: "The relay connection ended before the file was ready."};
      if ("error" in file) return file;
      try {
        if (!await stillEligible()) return {error: "The page changed before the file was saved."};
        report({filename: offer.filename, phase: "saving", stage: "Writing to Downloads"});
        const id = await saveVerifiedDownload(chrome.downloads, {
          url: file.blobUrl, filename: file.filename, conflictAction: "uniquify",
        });
        saved = true;
        const [item] = await chrome.downloads.search({id}).catch(() => []);
        const savedAs = item?.filename.split(/[/\\]/).pop() || file.filename;
        report({filename: offer.filename, phase: "saved", savedAs});
        return {saved: savedAs};
      } finally {
        chrome.runtime.sendMessage({type: "release-output", blobUrl: file.blobUrl}, () => void chrome.runtime.lastError);
      }
    } finally {
      chrome.runtime.onMessage.removeListener(receiveProgress);
      if (!saved) {
        clearRelayStatus(tabId, pageUrl);
        onProgress(requestId, null);
      }
      await permit.finish(saved);
    }
  }
  const result = save().catch(() => ({error: "Chrome could not finish saving the file."}))
    .finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}
