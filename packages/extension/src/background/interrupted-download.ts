import { isJobError, type JobError } from "@savemedia/core";
import type { DiscoveryFailure, FileDownloadOffer, FileRecoveryProgress, FileSaveProblem } from "../types/messages";
import { canonicalAddress } from "../util/media-address";
import { waitForDownload } from "./browser-download";
import { namedFileIdentity, reserveSave, savedThisSession } from "./session-saves";

const interruptReasons = new Set(["NETWORK_FAILED", "NETWORK_TIMEOUT", "NETWORK_DISCONNECTED", "NETWORK_SERVER_DOWN",
  "SERVER_FAILED", "SERVER_CONTENT_LENGTH_MISMATCH", "FILE_TRANSIENT_ERROR", "CRASH", "USER_SHUTDOWN"]);
/**
 * Danger states Chrome has resolved as safe: no danger, the user accepted it,
 * a deep scan cleared it, or an enterprise policy allowlists it. Chrome
 * resumes its own file; unresolved or dangerous states stay excluded.
 */
const resolvedSafe = new Set<string>(["safe", "accepted", "deepScannedSafe", "allowlistedByPolicy"]);

function itemUrl(item: chrome.downloads.DownloadItem): string { return item.finalUrl || item.url; }

/**
 * A video by the type its server declared when Chrome started the download.
 * Its bytes cannot be read here, so a file name or address suffix never
 * stands in for them: an item without a video/* type is downloaded afresh,
 * and verified, instead of resumed.
 */
function isInterruptedVideo(item: chrome.downloads.DownloadItem): boolean {
  if (item.state !== "interrupted" || item.incognito || !resolvedSafe.has(item.danger) || !interruptReasons.has(item.error ?? "")
    || !Number.isSafeInteger(item.bytesReceived) || item.bytesReceived <= 0
    || (item.totalBytes > 0 && item.bytesReceived >= item.totalBytes)) return false;
  try {
    const url = new URL(itemUrl(item));
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && /^video\//i.test(item.mime ?? "");
  } catch { return false; }
}

function sameSource(item: chrome.downloads.DownloadItem, offer: FileDownloadOffer): boolean {
  return [item.url, item.finalUrl].some(url => url && canonicalAddress(url) === canonicalAddress(offer.url));
}

/**
 * Chrome's download for this file: the same declared link, or the same name
 * started from this page. Query parameters are never read as signatures: a
 * link the page renewed is matched through the page and the file name.
 */
export function matchesInterruptedFile(item: chrome.downloads.DownloadItem, pageUrl: string, offer: FileDownloadOffer): boolean {
  if (!isInterruptedVideo(item)) return false;
  if (sameSource(item, offer)) return true;
  const basename = item.filename.split(/[/\\]/).at(-1)?.replace(/\.crdownload$/i, "");
  if (!basename || basename !== offer.filename && basename.replace(/ \(\d+\)(?=\.[^.]+$)/, "") !== offer.filename) return false;
  return !!item.referrer && canonicalAddress(pageUrl) === canonicalAddress(item.referrer);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findInterruptedFile(pageUrl: string, offer: FileDownloadOffer) {
  // Chromium can serialize a resumable item as "interrupted" while its
  // state-filtered search still omits it. Search by file identity, then
  // examine the actual state and reason on the returned DownloadItem.
  // Chrome adds " (1)" before the extension of a name already in Downloads.
  const dot = offer.filename.lastIndexOf(".");
  const suffix = dot > 0 ? offer.filename.slice(dot) : "";
  const stem = suffix ? offer.filename.slice(0, -suffix.length) : offer.filename;
  const filenameRegex = escapeRegex(stem) + "( \\(\\d+\\))?" + escapeRegex(suffix) + "(\\.crdownload)?$";
  const names = await chrome.downloads.search({filenameRegex, orderBy: ["-startTime"]});
  const matchSource = (item: chrome.downloads.DownloadItem) => isInterruptedVideo(item) && sameSource(item, offer);
  const named = names.find(matchSource);
  if (named) return named;
  const address = new URL(offer.url);
  const urlPattern = "^" + escapeRegex(address.origin + address.pathname) + "([?#]|$)";
  for (const query of [{finalUrlRegex: urlPattern}, {urlRegex: urlPattern}]) {
    const matched = (await chrome.downloads.search({...query, orderBy: ["-startTime"]})).find(matchSource);
    if (matched) return matched;
  }
  const candidates = names.filter(item => matchesInterruptedFile(item, pageUrl, offer));
  return new Set(candidates.map(item => canonicalAddress(itemUrl(item)))).size === 1 ? candidates[0] : undefined;
}

/**
 * True when savemedia's own look at this link, for the page as it is now,
 * was answered with something that is no video: a web page, a data
 * document, bytes of no video format. The browser's resume would write the
 * same kind of answer into the user's file, so the file is downloaded afresh
 * and verified instead. A server that was busy or refused the check says
 * nothing about what a resume gets, and the resume goes ahead.
 */
export function answeredWithoutVideo(failures: readonly DiscoveryFailure[], url: string): boolean {
  const address = canonicalAddress(url);
  return failures.some(failure => failure.error.code === "unexpected_media_response" && canonicalAddress(failure.url) === address);
}

export type FileRecoveryResult = {handled: "saved" | "skipped"} | {problem: FileSaveProblem} | null;

function hostOfItem(item: chrome.downloads.DownloadItem): string {
  try { return new URL(itemUrl(item)).host; } catch { return ""; }
}

/**
 * Looks at the download Chrome just finished resuming. A server may answer
 * the resume with something else than the rest of the file: an expired link
 * sends a web page with success, and Chrome then starts the file again from
 * that answer. Chrome reports the type the server declared for what it
 * wrote, so a finished item that is no longer a video is not what the user
 * asked for: its file is removed, and the reason is returned.
 *
 * This reads what the server declared, not the file: the bytes Chrome wrote
 * are still not verified by savemedia.
 */
export async function settleResumedDownload(api: Pick<typeof chrome.downloads, "search" | "removeFile">, id: number): Promise<JobError | null> {
  const [item] = await api.search({id});
  if (!item || item.state !== "complete") return null;
  if (/^video\//i.test(item.mime ?? "")) return null;
  // The file may be gone already; the answer to the user is the same.
  await api.removeFile(id).catch(() => undefined);
  return {code: "unexpected_media_response", severity: "terminal", host: hostOfItem(item),
    response: /^(?:text\/html|application\/xhtml\+xml)\b/i.test(item.mime ?? "") ? "page" : "data"};
}

/** Continue Chrome's own interrupted download of this file with downloads.resume. */
export async function recoverInterruptedDownload(tabId: number, pageUrl: string, offer: FileDownloadOffer,
  report: (status: FileRecoveryProgress | null, error?: JobError) => void,
  onStarted?: (downloadId: number, receiptKey: string) => void): Promise<FileRecoveryResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.incognito || tab.url !== pageUrl || await savedThisSession(pageUrl, offer.filename)) return null;
  const item = await findInterruptedFile(pageUrl, offer);
  if (!item?.canResume) return null;
  const permit = await reserveSave(namedFileIdentity(pageUrl, offer.filename), tabId, pageUrl, offer.filename);
  if (!permit) return {handled: "skipped"};
  let saved = false;
  let failure: JobError | undefined;
  const show = (current: chrome.downloads.DownloadItem) => report({stage: {kind: "resuming"},
    bytesWritten: current.bytesReceived, bytesTotal: current.totalBytes > 0 ? current.totalBytes : null});
  try {
    if ((await chrome.tabs.get(tabId)).url !== pageUrl) return {handled: "skipped"};
    show(item);
    try {
      await chrome.downloads.resume(item.id);
      // From here a restarted worker can wait for this download itself.
      if (permit.receiptKey) onStarted?.(item.id, permit.receiptKey);
      await waitForDownload(chrome.downloads, item.id, show);
    } catch (error) {
      const [latest] = await chrome.downloads.search({id: item.id});
      if (latest?.state === "in_progress") await waitForDownload(chrome.downloads, latest.id, show);
      else if (latest?.state !== "complete") throw error;
    }
    const refused = await settleResumedDownload(chrome.downloads, item.id);
    if (refused) throw refused;
    saved = true;
    return {handled: "saved"};
  } catch (error) {
    // Chrome names its interrupt reason in a closed code, such as NETWORK_FAILED.
    const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "";
    const jobError: JobError = isJobError(error) ? error
      : {code: "engine_job_failed", severity: "terminal", at: "direct", cause: "browser-resume", detail: reason};
    failure = jobError;
    return {problem: {filename: offer.filename, stage: "transferring", error: jobError}};
  } finally {
    await permit.finish(saved);
    report(null, failure);
  }
}
