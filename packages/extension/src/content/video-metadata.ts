// Metadata supplies candidates for the same byte and manifest checks as player sources.
import { mimeKind } from "../util/media-url";

export interface VideoMetadata {
  readonly primary: boolean;
  readonly via: "json-ld" | "og";
  readonly sources: { url: string; height?: number; mime?: string }[];
}

export interface PageVideoMetadata {
  readonly groups: VideoMetadata[];
  /** Images the page declares as stills of its videos; never a video to save. */
  readonly thumbnails: string[];
  /**
   * The page's og:image when its og:video names an embed page and nothing else says that the page is a
   * video. Such a page may be a player page, whose og:image is the player's poster, or an article with a
   * video further down, whose og:image is its lead photo. The picture is a still only where it lies on a
   * player (content/pointer-media.ts); anywhere else it is a picture like any other.
   */
  readonly playerStills: string[];
}

type Node = Record<string, unknown>;
const MAX_NODES = 500;

export function readVideoMetadata(doc: Document, pageUrl: string): PageVideoMetadata {
  const base = doc.baseURI === "about:blank" ? pageUrl : doc.baseURI;
  const nodes: Node[] = [];
  const definitions = new Map<string, Node>();
  for (const script of doc.querySelectorAll('script[type="application/ld+json" i]')) {
    const text = script.textContent ?? "";
    if (!text || text.length > 2_000_000) continue;
    let root: unknown;
    try { root = JSON.parse(text); } catch { continue; }
    const queue = values(root);
    for (let i = 0; i < queue.length && nodes.length < MAX_NODES; i++) {
      const node = queue[i];
      if (!isNode(node)) continue;
      nodes.push(node);
      const id = absolute(node["@id"], base);
      if (id && Object.keys(node).length > 1) definitions.set(id, node);
      for (const field of ["@graph", "mainEntity", "video", "encoding", "associatedMedia"]) {
        for (const child of values(node[field])) {
          if (queue.length >= MAX_NODES) break;
          if (isNode(child)) queue.push(child);
        }
      }
    }
    if (nodes.length >= MAX_NODES) break;
  }

  function resolve(ref: unknown): Node | undefined {
    const id = absolute(isNode(ref) ? ref["@id"] : ref, base);
    return (id ? definitions.get(id) : undefined) ?? (isNode(ref) ? ref : undefined);
  }

  const primary = new Set<Node>();
  const pageAddresses = new Set([pageUrl.split("#")[0]]);
  const canonical = absolute(doc.querySelector('link[rel~="canonical" i]')?.getAttribute("href"), base);
  if (canonical) pageAddresses.add(canonical.split("#")[0]);
  function currentPage(ref: unknown): boolean {
    const url = absolute(isNode(ref) ? ref["@id"] ?? ref.url : ref, base);
    return !!url && pageAddresses.has(url.split("#")[0]);
  }

  for (const node of nodes) {
    if (isType(node, "VideoObject") && values(node.mainEntityOfPage).some(currentPage)) primary.add(node);
    if (isType(node, "WebPage") && (!node.url && !node["@id"] || currentPage(node.url) || currentPage(node["@id"]))) {
      for (const value of values(node.mainEntity)) {
        const item = resolve(value);
        if (item) primary.add(item);
      }
    }
  }
  const groups: VideoMetadata[] = [];
  const thumbnails = new Set<string>();
  const encodings = new Set<Node>();
  for (const node of nodes.filter(n => isType(n, "VideoObject"))) {
    for (const ref of [...values(node.encoding), ...values(node.associatedMedia)]) {
      const encoding = resolve(ref);
      if (encoding && encoding !== node) encodings.add(encoding);
    }
  }
  for (const node of nodes) {
    if (!isType(node, "VideoObject") || encodings.has(node)) continue;
    const group: VideoMetadata = { primary: primary.has(node), via: "json-ld", sources: [] };
    for (const still of values(node.thumbnailUrl)) {
      const url = absolute(isNode(still) ? still.url ?? still["@id"] : still, base);
      if (url) thumbnails.add(url);
    }
    for (const item of [node, ...values(node.encoding).map(resolve), ...values(node.associatedMedia).map(resolve)]) {
      if (!item || isType(item, "AudioObject") || isType(item, "ImageObject")) continue;
      const format = typeof item.encodingFormat === "string" ? item.encodingFormat : "";
      if (/^(audio|image|text)\//i.test(format)) continue;
      const height = resolution(item.height) ?? resolution(item.videoQuality);
      for (const contentUrl of values(item.contentUrl)) {
        const url = absolute(isNode(contentUrl) ? contentUrl["@id"] : contentUrl, base);
        if (url) group.sources.push({ url, ...(height ? { height } : {}), ...(format.includes("/") ? { mime: format } : {}) });
      }
    }
    if (group.sources.length) groups.push(group);
  }

  // Each og:video root describes its own object. Its secure_url and height
  // apply only until another root is declared.
  let urls: string[] = [];
  let height: number | undefined;
  let type = "";
  // The page declares a video this way at all, whatever its type: an embed page (text/html) is no source to check.
  let declaresOgVideo = false;
  // One of them is media itself: a file or a stream, by its type, or with no type stated.
  let declaresOgMedia = false;
  function finishOgVideo(): void {
    if (urls.length && (!type || mimeKind(type) !== null)) {
      groups.push({ primary: false, via: "og", sources: urls.map(url => ({ url, ...(height ? { height } : {}), ...(type ? { mime: type } : {}) })) });
      declaresOgMedia = true;
    }
    urls = []; height = undefined; type = "";
  }
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[property^="og:video" i]')) {
    const property = meta.getAttribute("property")?.toLowerCase();
    if (property === "og:video" || property === "og:video:url") {
      finishOgVideo();
      const url = absolute(meta.content, base);
      if (url) { urls.push(url); declaresOgVideo = true; }
    } else if (property === "og:video:secure_url") {
      const url = absolute(meta.content, base);
      if (url?.startsWith("https://")) urls.unshift(url);
    } else if (property === "og:video:height") height = resolution(meta.content);
    else if (property === "og:video:type") type = meta.content.trim().toLowerCase();
  }
  finishOgVideo();
  // og:image is the picture of the object the page declares. It is the still of a video when that object
  // is one: an og:video that is media itself, or a page whose og:type is a video type (video.movie,
  // video.episode, video.other). An og:video that names an embed page says less: an article with a video
  // further down declares the same, and its og:image is the article's lead photo.
  const playerStills = new Set<string>();
  if (declaresOgVideo) {
    const pageIsVideo = Array.from(doc.querySelectorAll<HTMLMetaElement>('meta[property="og:type" i]'))
      .some(meta => /^video(\.|$)/i.test(meta.content.trim()));
    const stills = declaresOgMedia || pageIsVideo ? thumbnails : playerStills;
    for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[property="og:image" i], meta[property="og:image:secure_url" i]')) {
      const url = absolute(meta.content, base);
      if (url) stills.add(url);
    }
  }
  return { groups, thumbnails: [...thumbnails].slice(0, 50), playerStills: [...playerStills].filter(url => !thumbnails.has(url)).slice(0, 50) };
}

function absolute(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value, base);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Ignore malformed metadata. */ }
  return undefined;
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isType(node: Node, type: string): boolean {
  return values(node["@type"]).some(value => value === type || value === `https://schema.org/${type}` || value === `http://schema.org/${type}`);
}

export function resolution(value: unknown): number | undefined {
  if (isNode(value)) {
    if (value.unitText && !/^(px|pixels?)$/i.test(String(value.unitText))) return undefined;
    value = value.value;
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = /^(?:\d{2,5}\s*[x×]\s*)?(\d{2,5})(?:p|px)?$/i.exec(String(value).trim());
  const height = match ? Number(match[1]) : 0;
  return height > 0 && height <= 16384 ? height : undefined;
}
