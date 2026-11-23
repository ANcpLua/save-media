// MAIN world. Notes which media addresses the page's own ad responses name,
// so ads are never offered, probed or saved. It reads VAST and VMAP
// documents and HLS interstitial schedules the page already received. It
// never requests an ad, a wrapper or a tracking address, and never touches a
// media element.
import { assetListUris, hlsInterstitials, vastMediaFiles } from "../../util/ad-signals";
import { isManifestMime, urlKind } from "../../util/media-url";
import type { ResponseWatcher } from "./observe-responses";

export type AdVia = "vast" | "vmap" | "hls-interstitial" | "hls-asset-list";

export function adWatcher(post: (adUrls: readonly string[], via: AdVia) => void, Parser: typeof DOMParser = DOMParser): ResponseWatcher {
  const assetLists = new Set<string>();
  const parser = new Parser();
  return {
    wants(url, contentType) {
      return isManifestMime(contentType) || /^[^;]*\bxml\b|^\s*text\/plain/i.test(contentType) || urlKind(url) === "manifest"
        || assetLists.has(url.split("#", 1)[0]!);
    },
    // An ad document is markup and a playlist starts with its tag: any other body, such as JSON served as text, is let go unread.
    wantsBody(url, prefix) {
      const start = prefix.trimStart();
      return start === "" || start.startsWith("<") || start.startsWith("#EXTM3U") || assetLists.has(url.split("#", 1)[0]!);
    },
    read(url, body) {
      if (typeof body !== "string") {
        const found = vastMediaFiles(body, url);
        if (found?.urls.length) post(found.urls, found.via);
        return;
      }
      const text = body.trimStart();
      if (assetLists.has(url.split("#", 1)[0]!)) {
        const assets = assetListUris(text, url);
        if (assets.length) post(assets, "hls-asset-list");
      } else if (text.startsWith("#EXTM3U")) {
        if (!text.includes("com.apple.hls.interstitial")) return;
        const { assetUris, assetLists: lists } = hlsInterstitials(text, url);
        for (const list of lists) if (assetLists.size < 50) assetLists.add(list);
        if (assetUris.length) post(assetUris, "hls-interstitial");
      } else if (text.startsWith("<") && /<(?:\w+:)?(?:VAST|VMAP)[\s>]/i.test(text.slice(0, 2000))) {
        const found = vastMediaFiles(parser.parseFromString(text, "text/xml"), url);
        if (found?.urls.length) post(found.urls, found.via);
      }
    },
  };
}
