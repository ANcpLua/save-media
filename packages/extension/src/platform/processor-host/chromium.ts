/**
 * Chromium's engine document: an offscreen document.
 *
 * An MV3 service worker has no DOM and cannot keep Blob URLs alive across
 * its restarts, so the engine runs in an offscreen document that is created
 * for the first job and closed when the engine is idle. These are only the
 * three primitives; when they run, and in which order, is the engine
 * channel's decision (background/engine-channel.ts).
 */

const OFFSCREEN_DOCUMENT_PATH = "src/engine/offscreen.html";

interface OffscreenContext { readonly documentUrl?: string }
type GetContextsFn = (filter: { contextTypes: string[]; documentUrls?: string[] }) => Promise<OffscreenContext[]>;
interface WindowClients { matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly { readonly url: string }[]> }

export async function engineDocumentExists(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const getContexts = (chrome.runtime as unknown as { getContexts?: GetContextsFn }).getContexts;
  if (getContexts) return (await getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })).length > 0;
  // Chrome 114 and 115 have no runtime.getContexts. The offscreen document is a window client of the extension's origin.
  const clients = (globalThis as unknown as { clients?: WindowClients }).clients;
  if (!clients) return false;
  return (await clients.matchAll({ type: "window", includeUncontrolled: true })).some(client => client.url === url);
}

export async function createEngineDocument(): Promise<void> {
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["BLOBS" as chrome.offscreen.Reason],
    justification: "Verifies browser-side media downloads and creates Blob URLs.",
  });
}

export async function closeEngineDocument(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // No offscreen document is open.
  }
}
