// Metadata supplies candidates for the same byte and manifest checks as player sources.
export interface VideoMetadata {
  readonly primary: boolean;
  readonly sources: { url: string; height?: number }[];
}

type Node = Record<string, unknown>;
const MAX_NODES = 500;

export function readVideoMetadata(doc: Document, pageUrl: string): VideoMetadata[] {
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
  const encodings = new Set<Node>();
  for (const node of nodes.filter(n => isType(n, "VideoObject"))) {
    for (const ref of [...values(node.encoding), ...values(node.associatedMedia)]) {
      const encoding = resolve(ref);
      if (encoding && encoding !== node) encodings.add(encoding);
    }
  }
  for (const node of nodes) {
    if (!isType(node, "VideoObject") || encodings.has(node)) continue;
    const group: VideoMetadata = { primary: primary.has(node), sources: [] };
    for (const item of [node, ...values(node.encoding).map(resolve), ...values(node.associatedMedia).map(resolve)]) {
      if (!item || isType(item, "AudioObject") || isType(item, "ImageObject")) continue;
      const format = typeof item.encodingFormat === "string" ? item.encodingFormat : "";
      if (/^(audio|image|text)\//i.test(format)) continue;
      const height = resolution(item.height) ?? resolution(item.videoQuality);
      for (const contentUrl of values(item.contentUrl)) {
        const url = absolute(isNode(contentUrl) ? contentUrl["@id"] : contentUrl, base);
        if (url) group.sources.push({ url, ...(height ? { height } : {}) });
      }
    }
    if (group.sources.length) groups.push(group);
  }

  // Each og:video root describes its own object. Its secure_url and height
  // apply only until another root is declared.
  let urls: string[] = [];
  let height: number | undefined;
  let type = "";
  function finishOgVideo(): void {
    if (urls.length && (!type || type.startsWith("video/") || /mpegurl|dash\+xml/i.test(type))) {
      groups.push({ primary: false, sources: urls.map(url => ({ url, ...(height ? { height } : {}) })) });
    }
    urls = []; height = undefined; type = "";
  }
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[property^="og:video" i]')) {
    const property = meta.getAttribute("property")?.toLowerCase();
    if (property === "og:video" || property === "og:video:url") {
      finishOgVideo();
      const url = absolute(meta.content, base);
      if (url) urls.push(url);
    } else if (property === "og:video:secure_url") {
      const url = absolute(meta.content, base);
      if (url?.startsWith("https://")) urls.unshift(url);
    } else if (property === "og:video:height") height = resolution(meta.content);
    else if (property === "og:video:type") type = meta.content.trim().toLowerCase();
  }
  finishOgVideo();
  return groups;
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
