import type { Locator, Page, Worker } from "@playwright/test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExtensionSession } from "./extension-browser";
import type { BackgroundToPopupMessage, PopupRequest } from "../../src/types/messages";

/**
 * What the extension suites share besides the launch (extension-browser.ts)
 * and the service worker (extension-worker.ts): finding a tab, opening the
 * popup for it, the Alt+S toast, asking for a save, and the shape of a tab's
 * view. The messages are built here from the extension's own types, so a
 * field the extension adds to a request is a type error in one place.
 */

/** Where a question to the browser is asked: a page of the extension, or its service worker. */
type ExtensionRealm = Page | Worker;

/** The id of the tab that shows this address, or undefined while no tab does. */
export function findTabId(realm: ExtensionRealm, url: string): Promise<number | undefined> {
  // A page and a worker evaluate alike; the cast only picks one of the two signatures.
  return (realm as Page).evaluate(async address => (await chrome.tabs.query({})).find(tab => tab.url === address)?.id, url);
}

/** The id of the tab that shows this address. */
export async function tabIdOf(realm: ExtensionRealm, url: string): Promise<number> {
  const id = await findTabId(realm, url);
  if (id === undefined) throw new Error(`No tab shows ${url}.`);
  return id;
}

/** The popup as a page of its own, showing that tab, as the toolbar button opens it. */
export async function popupFor(session: ExtensionSession, tabId: number | undefined): Promise<Page> {
  if (tabId === undefined) throw new Error("The popup needs the tab it is opened for.");
  const popup = await session.context.newPage();
  await popup.goto(`${session.popupUrl}?tabId=${tabId}`);
  return popup;
}

/**
 * The Alt+S toast on a page. It lives in an open shadow root on this element (content/bridge.ts): the card
 * has the class `t`, its label (Saving, Saved, Not saved) `k` and the line below the label `d`.
 */
export const TOAST = '[data-savemedia="feedback"]';
/** The toast's element: it is on the page only while a toast shows. */
export const toast = (page: Page): Locator => page.locator(TOAST);
/** The toast's card: its text is the label followed by the detail. */
export const toastCard = (page: Page): Locator => page.locator(`${TOAST} .t`);
export const toastLabel = (page: Page): Locator => page.locator(`${TOAST} .k`);
export const toastDetail = (page: Page): Locator => page.locator(`${TOAST} .d`);

export interface SaveOptions {
  readonly variantId?: string | null | undefined;
  readonly audioRenditionId?: string | null | undefined;
}

type DownloadRequest = Extract<PopupRequest, { type: "download" }>;

/** The popup's request to save one listed stream under a name, as the Save button sends it. */
export function downloadRequest(streamId: string, filename: string, options: SaveOptions = {}): DownloadRequest {
  return {
    type: "download",
    streamId: streamId as DownloadRequest["streamId"],
    choice: {
      outputMode: "Original",
      filename,
      variantId: (options.variantId ?? null) as DownloadRequest["choice"]["variantId"],
      audioRenditionId: (options.audioRenditionId ?? null) as DownloadRequest["choice"]["audioRenditionId"],
    },
  };
}

/** How a save ended: the extension's own message, or that neither arrived in time. */
export type SaveOutcome = Extract<BackgroundToPopupMessage, { type: "job-complete" | "job-failed" }> | { readonly type: "timed-out" };

/**
 * Asks for a save from a page of the extension and waits until the extension says that this stream's save
 * finished or failed. The listener is in place before the request leaves.
 */
export function saveAndWait(extensionPage: Page, streamId: string, filename: string, options: SaveOptions & { readonly timeout?: number } = {}): Promise<SaveOutcome> {
  return extensionPage.evaluate(async ({ request, timeout }) => {
    const finished = new Promise<unknown>(resolve => {
      const timer = setTimeout(() => { chrome.runtime.onMessage.removeListener(listener); resolve({ type: "timed-out" }); }, timeout);
      function listener(message: { type: string; streamId?: string }): void {
        if (message.streamId !== request.streamId || (message.type !== "job-complete" && message.type !== "job-failed")) return;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message);
      }
      chrome.runtime.onMessage.addListener(listener);
    });
    await chrome.runtime.sendMessage(request);
    return finished;
  }, { request: downloadRequest(streamId, filename, options), timeout: options.timeout ?? 15_000 }) as Promise<SaveOutcome>;
}

/**
 * A tab's view as the background answers "list" and "rescan" (DescriptorsMessage), reduced to what the
 * suites read. The names are the message's own.
 */
export interface View {
  descriptors: {
    id: string;
    protocol: string;
    drm?: { reason: string } | null;
    presentation?: { live: boolean };
    source: { kind: string; url?: string; manifestUrl?: string; elementSrc?: string };
  }[];
  failures?: { url: string }[];
  statuses?: Record<string, { phase: string; fileName?: string; error?: { code: string; when?: string } }>;
  selection?: { state: string; mainId: string | null; elementMain: boolean; cards: { ids: string[]; live: boolean }[]; ads?: { ids: string[]; live: boolean }[] };
  pageUrl?: string;
  notSaved?: string;
  reach?: string | null;
}

/** The part of a file a request asks for: all of it, or the range its Range header names. */
function requestedPart(req: IncomingMessage, bytes: Buffer): { start: number; end: number; ranged: boolean } {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return { start, end, ranged: !!range };
}

/**
 * Starts the answer a server that supports ranges gives for an MP4 file: the status and headers for the
 * part the request asks for, with a validator, and nothing of the body yet. A suite's own server uses it
 * when it wants to hold the body back or send only some of it.
 */
export function beginRangeAnswer(req: IncomingMessage, res: ServerResponse, bytes: Buffer): { start: number; end: number } {
  const { start, end, ranged } = requestedPart(req, bytes);
  res.writeHead(ranged ? 206 : 200, { "content-type": "video/mp4", "accept-ranges": "bytes", etag: '"fixture-v1"',
    "content-length": end - start + 1, ...(ranged ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}) });
  return { start, end };
}

/** Answers a request for an MP4 file as a server that supports ranges does, body included. */
export function answerWithRange(req: IncomingMessage, res: ServerResponse, bytes: Buffer): void {
  const { start, end } = beginRangeAnswer(req, res, bytes);
  res.end(bytes.subarray(start, end + 1));
}
