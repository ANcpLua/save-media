/**
 * Firefox's background is an event page with a DOM, so the engine runs in
 * the background page itself (background/engine-channel.ts,
 * createInProcessEngineChannel). There is no separate document to create or
 * close, and chrome.offscreen does not exist there.
 */

export async function engineDocumentExists(): Promise<boolean> {
  return true;
}

export async function createEngineDocument(): Promise<void> {
  // The engine lives in the background page.
}

export async function closeEngineDocument(): Promise<void> {
  // Its lifetime is the background page's.
}
