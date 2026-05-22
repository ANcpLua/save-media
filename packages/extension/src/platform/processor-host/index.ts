/**
 * Browser-target abstraction over the engine host context.
 *
 * Chromium MV3 service workers cannot host a Web Worker / DOM, so the engine
 * runs in a chrome.offscreen document. Firefox MV3 event pages still have a
 * DOM, so the engine loads alongside the background script.
 *
 * The build defines `__BROWSER__` (see vite.config.ts) so the static
 * dispatch collapses at build time and each per-target bundle imports only
 * its own implementation. The dev/test fallback is chromium.
 */

declare const __BROWSER__: "chromium" | "firefox";

export interface ProcessorHost {
  readonly ensureEngineHost: () => Promise<void>;
  readonly closeEngineHost: () => Promise<void>;
}

let cached: ProcessorHost | null = null;

async function load(): Promise<ProcessorHost> {
  if (cached) return cached;
  const target: "chromium" | "firefox" =
    typeof __BROWSER__ === "undefined" ? "chromium" : __BROWSER__;
  cached = target === "firefox"
    ? await import("./firefox")
    : await import("./chromium");
  return cached;
}

export const ensureEngineHost: ProcessorHost["ensureEngineHost"] = async () => {
  const impl = await load();
  return impl.ensureEngineHost();
};

export const closeEngineHost: ProcessorHost["closeEngineHost"] = async () => {
  const impl = await load();
  return impl.closeEngineHost();
};
