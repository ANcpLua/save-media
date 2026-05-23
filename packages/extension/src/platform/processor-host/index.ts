/**
 * Browser-target abstraction over the engine host context.
 *
 * Chromium MV3 service workers cannot host a Web Worker / DOM, so the
 * engine runs in a chrome.offscreen document. Firefox MV3 event pages
 * still have a DOM, so the engine loads alongside the background script.
 *
 * Both implementations are STATICALLY imported here. Earlier this file
 * used `await import("./firefox")`/`await import("./chromium")` to
 * switch at runtime, but MV3 service workers forbid dynamic `import()`
 * entirely (HTML spec — see github.com/w3c/ServiceWorker/issues/1356).
 * The dynamic call crashed every SW startup with
 * `TypeError: import() is disallowed on ServiceWorkerGlobalScope`.
 *
 * Static imports + the `__BROWSER__` define let vite tree-shake the
 * unused branch at build time, so each browser bundle contains only its
 * own engine-host implementation.
 */

import * as chromium from "./chromium";
import * as firefox from "./firefox";

declare const __BROWSER__: "chromium" | "firefox";

const impl = (typeof __BROWSER__ !== "undefined" && __BROWSER__ === "firefox")
  ? firefox
  : chromium;

export const ensureEngineHost = impl.ensureEngineHost;
export const closeEngineHost = impl.closeEngineHost;
