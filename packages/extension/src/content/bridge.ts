// Content scripts in MV3 are injected as classic scripts — `import` is
// a syntax error. We intentionally duplicate this constant (also defined
// in src/types/messages.ts) so this file has no module dependencies and
// can ship as a standalone JS file.
//
// See content/main.ts for why the `export {}` marker is here.
export {};
const BRIDGE_TAG = "__savemedia" as const;

interface MainPayload {
  [BRIDGE_TAG]: true;
  kind: string;
  url: string | null;
  pageUrl: string;
  [key: string]: unknown;
}

window.addEventListener("message", event => {
  if (event.source !== window) return;
  const data = event.data as MainPayload | null;
  if (!data || data[BRIDGE_TAG] !== true) return;
  chrome.runtime.sendMessage(
    { type: "capture", payload: data },
    () => void chrome.runtime.lastError,
  );
});

chrome.runtime.sendMessage(
  { type: "ready" },
  () => void chrome.runtime.lastError,
);
