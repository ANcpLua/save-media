// Service-worker shim for browser-only third-party libraries.
//
// m3u8-parser (videojs) and mpd-parser (videojs) reference `window` AT
// MODULE LOAD — checking window.atob, window.URL, window.BigInt, etc.
// In a Manifest V3 service worker, `window` is undefined, so importing
// @savemedia/core (which transitively imports both parsers) crashes
// the SW with `ReferenceError: window is not defined` before our
// onMessage listener even registers.
//
// Aliasing window → globalThis is safe because:
//   - globalThis has every API those libs touch (atob, URL, BigInt,
//     fetch, crypto, …)
//   - the libs never assign to window.X; they only read
//   - workers have always had `self === globalThis`, so this matches
//     what the libs would see in a web worker
//
// This file MUST be the first thing background/index.ts imports so the
// shim is in place before any transitive `import "m3u8-parser"` evaluates.
const g = globalThis as { window?: unknown };
if (typeof g.window === "undefined") {
  g.window = globalThis;
}

export {};
