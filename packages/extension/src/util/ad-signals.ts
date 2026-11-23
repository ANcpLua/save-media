// Ad signals a page's own responses declare: VAST and VMAP media files, HLS
// interstitials and their asset lists. Read only, never fetched. This module
// imports nothing, so the MAIN-world content script can inline it.

const LIMIT = 100;

function absolute(raw: string, baseUrl: string): string | null {
  try {
    const url = new URL(raw.trim(), baseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/**
 * The media files an inline VAST document, or the VAST inside a VMAP
 * document, names: every MediaFile and Mezzanine. Wrapper tag addresses
 * (VASTAdTagURI, AdTagURI) are never read or fetched.
 */
export function vastMediaFiles(doc: Document, baseUrl: string): { via: "vast" | "vmap"; urls: string[] } | null {
  const root = doc.documentElement;
  const name = root?.localName?.toLowerCase();
  if (name !== "vast" && name !== "vmap") return null;
  const urls = new Set<string>();
  for (const element of root.getElementsByTagName("*")) {
    const local = element.localName.toLowerCase();
    if (local !== "mediafile" && local !== "mezzanine") continue;
    const url = absolute(element.textContent ?? "", baseUrl);
    if (url) urls.add(url);
    if (urls.size >= LIMIT) break;
  }
  return { via: name, urls: [...urls] };
}

/** One attribute list of an HLS tag, with quoted strings (which may hold commas) unquoted. */
function attributes(list: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g;
  for (let match = pattern.exec(list); match; match = pattern.exec(list)) {
    const value = match[2]!;
    result.set(match[1]!, value.startsWith('"') ? value.slice(1, -1) : value);
  }
  return result;
}

/** Interstitial assets a playlist's EXT-X-DATERANGE tags schedule. */
export function hlsInterstitials(text: string, baseUrl: string): { assetUris: string[]; assetLists: string[] } {
  const assetUris = new Set<string>();
  const assetLists = new Set<string>();
  if (!text.includes("com.apple.hls.interstitial")) return { assetUris: [], assetLists: [] };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-DATERANGE:")) continue;
    const fields = attributes(line.slice("#EXT-X-DATERANGE:".length));
    if (fields.get("CLASS") !== "com.apple.hls.interstitial") continue;
    const uri = fields.get("X-ASSET-URI");
    const list = fields.get("X-ASSET-LIST");
    const asset = uri ? absolute(uri, baseUrl) : null;
    const assets = list ? absolute(list, baseUrl) : null;
    if (asset && assetUris.size < LIMIT) assetUris.add(asset);
    if (assets && assetLists.size < LIMIT) assetLists.add(assets);
  }
  return { assetUris: [...assetUris], assetLists: [...assetLists] };
}

/** The assets of an interstitial asset list: {"ASSETS":[{"URI":...}]}. */
export function assetListUris(json: string, baseUrl: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const assets = parsed && typeof parsed === "object" ? (parsed as { ASSETS?: unknown }).ASSETS : undefined;
  if (!Array.isArray(assets)) return [];
  const urls = new Set<string>();
  for (const item of assets) {
    const raw = item && typeof item === "object" ? (item as { URI?: unknown }).URI : undefined;
    const url = typeof raw === "string" ? absolute(raw, baseUrl) : null;
    if (url) urls.add(url);
    if (urls.size >= LIMIT) break;
  }
  return [...urls];
}
