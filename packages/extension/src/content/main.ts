// MAIN-world content script. MV3 injects content scripts as classic scripts,
// so the build makes this entry one self-contained IIFE (vite.config.ts) and
// fails if a module statement survives.
//
// Runtime imports come only from src/content/** and the pure, import-free
// modules in src/util (media-url, ad-signals). Imports from src/types are
// type-only. No zod and no @savemedia/core.
//
// What runs here must see the page's own objects: proof that a media element
// used a key, and the ad and site API responses the page receives. Everything
// else is read by the isolated bridge, where the page cannot forge it.
import { resolverForPage } from "./sites/registry";
import { adWatcher, type AdVia } from "./page/ad-watcher";
import { installEmeProof } from "./page/eme-proof";
import { observeResponses, type ResponseWatcher } from "./page/observe-responses";
import { resolverWatcher } from "./page/resolver-watcher";

const BRIDGE_TAG = "__savemedia" as const;

function absolute(url: string): string | null {
  try { return new URL(url, location.href).href; } catch { return null; }
}

installEmeProof();

const watchers: ResponseWatcher[] = [adWatcher((adUrls: readonly string[], adVia: AdVia) => {
  window.postMessage({ [BRIDGE_TAG]: true, kind: "ad-media", url: null, pageUrl: location.href, adUrls: adUrls.slice(0, 100), adVia }, "*");
})];

// On the hosts with a site resolver, the site's own API responses name the
// files. The resolver runs next to the generic observers, not instead of them.
const resolver = resolverForPage(location.href);
if (resolver) {
  watchers.push(resolverWatcher(resolver, (url, audio) => {
    const mediaUrl = absolute(url);
    const audioUrl = audio === undefined ? undefined : absolute(audio);
    if (!mediaUrl || audioUrl === null) return;
    window.postMessage({ [BRIDGE_TAG]: true, kind: "media-source", url: mediaUrl, pageUrl: location.href,
      ...(audioUrl === undefined ? {} : { audioUrl }) }, "*");
  }));
}

observeResponses(watchers);
