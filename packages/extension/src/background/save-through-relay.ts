import { saveVerifiedDownload } from "./browser-download";
import { ensureEngineHost } from "../platform/processor-host";
import type { RelayResult } from "../engine/relay-transfer";
import type { DiscoveredMedia, FileDownloadOffer, FileRelayStatus, FileRelayStatusMessage } from "../types/messages";

type SaveResult = {saved: string} | {error: string};
const pending = new Map<string, Promise<SaveResult>>();

export function saveThroughRelay(tabId: number, pageUrl: string, offer: FileDownloadOffer, source: DiscoveredMedia,
  stillEligible: () => Promise<boolean>): Promise<SaveResult> {
  const key = JSON.stringify([tabId, pageUrl, offer.filename, offer.linkedPage]);
  const existing = pending.get(key);
  if (existing) return existing;

  async function report(status: FileRelayStatus) {
    const msg: FileRelayStatusMessage = {type: "file-relay-status", tabId, pageUrl, status};
    await chrome.tabs.sendMessage(tabId, msg, {frameId: 0}).catch(() => undefined);
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  }
  async function save(): Promise<SaveResult> {
    if (!await stillEligible()) return {error: "The file is no longer available on this page."};
    await ensureEngineHost();
    await report({filename: offer.filename, phase: "saving"});
    const file: RelayResult | undefined = await chrome.runtime.sendMessage({
      type: "relay-file", filename: offer.filename, source, referrer: offer.linkedPage ?? pageUrl,
    }).catch(() => undefined);
    if (!file) return {error: "The relay connection ended before the file was ready."};
    if ("error" in file) return file;
    try {
      if (!await stillEligible()) return {error: "The page changed before the file was saved."};
      const id = await saveVerifiedDownload(chrome.downloads, {
        url: file.blobUrl, filename: file.filename, conflictAction: "uniquify",
      });
      const [item] = await chrome.downloads.search({id});
      const saved = item?.filename.split(/[/\\]/).pop() || file.filename;
      await report({filename: offer.filename, phase: "saved", savedAs: saved});
      return {saved};
    } finally {
      chrome.runtime.sendMessage({type: "release-output", blobUrl: file.blobUrl}, () => void chrome.runtime.lastError);
    }
  }
  const result = save().catch(() => ({error: "Chrome could not finish saving the file."}))
    .finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}
