/**
 * Firefox MV3 background context is an event page with DOM. The engine host
 * is loaded from the background's HTML shell, so this implementation only
 * needs to ensure the script is alive.
 *
 * No chrome.offscreen API is available; calling into chrome.offscreen.* here
 * would throw and break the Firefox build. The chromium implementation lives
 * in a separate file so tree-shaking by the build-time `__BROWSER__` define
 * removes the offscreen import path from the Firefox bundle.
 */

export async function ensureEngineHost(): Promise<void> {
  // Engine runs in the background event page's DOM; no setup needed.
}

export async function closeEngineHost(): Promise<void> {
  // No-op: lifetime tied to the event page itself.
}
