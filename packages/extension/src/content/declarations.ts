// The media a page's own data declares: a video's attributes, JSON in
// attributes and script tags, schema.org and Open Graph metadata, and file
// links. Values are read by what they are (an address with a media name or a
// sibling media type), never by the name of the key that holds them. Every
// candidate is still probed before it is offered.
import type { DeclaredGroup, DeclaredSource } from "../types/page-facts";
import { mayDeclareMedia, mimeKind, normalizeMediaUrl, worthProbing } from "../util/media-url";
import { declaredMediaFilename, publishedFileLinks } from "./discovery";
import { parentAcrossShadow } from "./media-tree";
import { readVideoMetadata } from "./video-metadata";

const LIMIT = 80;
const MAX_SCRIPT_CHARS = 2_000_000;
const SCAN_BUDGET_CHARS = 4_000_000;
const MAX_JSON_ATTRIBUTE_CHARS = 1_000_000;
const MAX_JSON_ATTRIBUTES = 500;
const MAX_NODES = 20_000;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
interface Candidate { readonly url: string; readonly height?: number; readonly mime?: string }

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A height a label states in the form "1080p" or "1920x1080". */
function labelledHeight(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const match = /^(\d{3,4})p$/i.exec(text) ?? /^\d{2,5}[x×](\d{2,5})$/.exec(text);
  const height = match ? Number(match[1]) : 0;
  return height > 0 && height <= 16384 ? height : undefined;
}

function siblingHeight(node: { [key: string]: Json }): number | undefined {
  const stated = node["height"];
  if (typeof stated === "number" && Number.isInteger(stated) && stated > 0 && stated <= 16384) return stated;
  for (const value of Object.values(node)) {
    const height = labelledHeight(value);
    if (height) return height;
  }
  return undefined;
}

function siblingMime(node: { [key: string]: Json }): string | undefined {
  for (const value of Object.values(node)) {
    if (typeof value === "string" && value.length < 100 && mimeKind(value)) return value;
  }
  return undefined;
}

/** An address: absolute, protocol-relative or a path. A bare "clip.mp4" is a name. */
function candidate(raw: string, base: string, mime?: string, height?: number): Candidate | null {
  const text = raw.trim();
  // A media type is a type, not an address, though it has a slash.
  if (!text || text.length > 8192 || /\s/.test(text) || mimeKind(text)) return null;
  if (!/^(https?:)?\/\//i.test(text) && !text.includes("/")) return null;
  const url = normalizeMediaUrl(text, base);
  if (!url || !worthProbing(url, { via: "declared", mime })) return null;
  return { url, ...(height ? { height } : {}), ...(mime ? { mime } : {}) };
}

interface Scan { readonly base: string; nodes: number }

function ownCandidates(node: { [key: string]: Json }, scan: Scan): Candidate[] {
  const mime = siblingMime(node);
  const found: { item: Candidate; keyed: boolean }[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "string") continue;
    const height = labelledHeight(key);
    const item = candidate(value, scan.base, mime, height);
    if (item) found.push({ item, keyed: height !== undefined });
  }
  // A height next to one address is that address's height. Next to several, it is nobody's.
  const shared = found.length === 1 ? siblingHeight(node) : undefined;
  return found.map(({ item, keyed }) => !keyed && shared ? { ...item, height: shared } : item);
}

/**
 * Structure decides what belongs together: an array whose entries all state
 * a different height lists renditions of one video; any other array is a
 * list of different videos.
 */
function groupsOf(node: Json, scan: Scan): Candidate[][] {
  if (++scan.nodes > MAX_NODES) return [];
  if (typeof node === "string") {
    const item = candidate(node, scan.base);
    return item ? [[item]] : [];
  }
  if (Array.isArray(node)) {
    const entries = node.map(item => groupsOf(item, scan)).filter(groups => groups.length > 0);
    const flat = entries.map(groups => groups.flat());
    const heights = flat.map(items => items.length === 1 ? items[0]!.height : undefined);
    const renditions = entries.length >= 2 && heights.every(height => height !== undefined) && new Set(heights).size === heights.length;
    return renditions ? [flat.flat()] : entries.flat();
  }
  if (!isObject(node)) return [];
  const own = ownCandidates(node, scan);
  const containers = Object.values(node).filter(value => value !== null && typeof value === "object")
    .map(value => groupsOf(value, scan)).filter(groups => groups.length > 0);
  if (containers.length === 1 && containers[0]!.length === 1) return [[...own, ...containers[0]![0]!]];
  return [own, ...containers.flat()].filter(group => group.length > 0);
}

// ---------- inline script literals ----------

const TOKEN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?|[{}\[\]:,=]/g;

function decodeLiteral(value: string): string {
  return value.slice(1, -1).replace(/\\(?:u([\da-f]{4})|x([\da-f]{2})|([\s\S]))/gi,
    (_all, unicode: string | undefined, hex: string | undefined, char: string | undefined) =>
      unicode || hex ? String.fromCharCode(parseInt(unicode ?? hex!, 16)) : ({ n: "\n", r: "\r", t: "\t" }[char ?? ""] ?? char ?? ""))
    .replace(/&amp;/g, "&");
}

interface Frame { readonly node: Json[] | { [key: string]: Json }; readonly attach: ((value: Json) => void) | null }

/**
 * The object and array literals of a script, as trees. One streaming pass
 * keeps only the nesting stack. Code blocks are braces without keys: they
 * hold no values, and literals inside them become roots of their own.
 */
export function scriptLiterals(text: string): Json[] {
  const roots: Json[] = [];
  const stack: Frame[] = [];
  let before = "";
  let beforeThat = "";
  let pendingKey: string | null = null;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
    const token = match[0];
    if (token.startsWith("/*") || token.startsWith("//")) continue;
    const top = stack.at(-1);
    const place = (value: Json): void => {
      if (!top) return;
      if (Array.isArray(top.node)) top.node.push(value);
      else if (pendingKey !== null) (top.node as { [key: string]: Json })[pendingKey] = value;
    };
    if (token === "{" || token === "[") {
      const node: Json[] | { [key: string]: Json } = token === "[" ? [] : Object.create(null) as { [key: string]: Json };
      const keyed = top && !Array.isArray(top.node) && pendingKey !== null;
      const key = pendingKey;
      const attach = top && Array.isArray(top.node) ? (value: Json) => { (top.node as Json[]).push(value); }
        : keyed ? (value: Json) => { (top.node as { [key: string]: Json })[key!] = value; } : null;
      stack.push({ node, attach });
      pendingKey = null;
    } else if (token === "}" || token === "]") {
      const frame = stack.pop();
      pendingKey = null;
      if (frame && Array.isArray(frame.node) === (token === "]")) {
        const empty = Array.isArray(frame.node) ? frame.node.length === 0 : Object.keys(frame.node).length === 0;
        if (frame.attach) frame.attach(frame.node);
        // A code block is braces without values: nothing to keep.
        else if (!empty && roots.length < 2000) roots.push(frame.node);
      }
    } else if (token === ":") {
      pendingKey = top && !Array.isArray(top.node) && (beforeThat === "{" || beforeThat === ",") && /^["'\w$]/.test(before)
        ? (/^["']/.test(before) ? decodeLiteral(before) : before) : null;
    } else if (token === ",") {
      pendingKey = null;
    } else if (token !== "=") {
      const first = token[0]!;
      if (first === '"' || first === "'" || first === "`") place(decodeLiteral(token));
      else if (/[-\d]/.test(first)) place(Number(token));
      else if (token === "true" || token === "false") place(token === "true");
      else if (token === "null") place(null);
      if (before === ":") pendingKey = null;
    }
    beforeThat = before;
    before = token;
  }
  return roots;
}

const scriptCache = new WeakMap<HTMLScriptElement, { readonly length: number; readonly roots: Json[] }>();

function scriptRoots(script: HTMLScriptElement, budget: { left: number }): Json[] {
  const text = script.textContent ?? "";
  const known = scriptCache.get(script);
  if (known && known.length === text.length) return known.roots;
  if (!text || text.length > MAX_SCRIPT_CHARS || text.length > budget.left) return [];
  let roots: Json[] = [];
  // A script that names no media suffix or type cannot declare a media address. A cost gate only: candidates are still checked.
  if (mayDeclareMedia(text)) {
    budget.left -= text.length;
    if (/json/i.test(script.type)) {
      try { roots = [JSON.parse(text) as Json]; } catch { roots = []; }
    } else roots = scriptLiterals(text);
  }
  scriptCache.set(script, { length: text.length, roots });
  return roots;
}

function isDataScript(script: HTMLScriptElement): boolean {
  const type = script.type.trim().toLowerCase();
  // Linked scripts have no text here, and schema.org data has its own reader.
  return !script.src && type !== "application/ld+json";
}

// ---------- assembling groups ----------

class Collector {
  readonly groups: DeclaredGroup[] = [];
  private count = 0;
  private ordinal = 0;
  constructor(private readonly prefix: string) {}

  add(via: DeclaredGroup["via"], proximity: DeclaredGroup["proximity"], items: readonly Candidate[], primary = false, path = ""): void {
    const groupId = `${this.prefix}:${via}:${this.ordinal++}:${path}`;
    const sources = new Map<string, DeclaredSource>();
    for (const item of items) {
      if (this.count + sources.size >= LIMIT) break;
      const previous = sources.get(item.url);
      sources.set(item.url, { url: item.url, groupId,
        ...(item.height ?? previous?.height ? { height: item.height ?? previous!.height! } : {}),
        ...(item.mime ?? previous?.mime ? { mime: item.mime ?? previous!.mime! } : {}) });
    }
    if (!sources.size) return;
    this.count += sources.size;
    this.groups.push({ groupId, via, proximity, primary, sources: [...sources.values()] });
  }

  addTrees(via: "attribute" | "script", proximity: DeclaredGroup["proximity"], roots: readonly Json[], base: string, path: string): void {
    const scan: Scan = { base, nodes: 0 };
    roots.forEach((root, index) => {
      for (const group of groupsOf(root, scan)) this.add(via, proximity, group, false, `${path}${index}`);
    });
  }
}

function jsonAttributes(element: Element, used: { count: number }): Json[] {
  const roots: Json[] = [];
  for (const attribute of element.attributes) {
    if (used.count >= MAX_JSON_ATTRIBUTES) break;
    const value = attribute.value.trim();
    if (value.length > MAX_JSON_ATTRIBUTE_CHARS || (!value.startsWith("{") && !value.startsWith("["))) continue;
    used.count++;
    try { roots.push(JSON.parse(value) as Json); } catch { /* Not JSON after all. */ }
  }
  return roots;
}

const STANDARD_ATTRIBUTES = new Set(["src", "poster", "type", "class", "id", "style", "width", "height", "preload", "crossorigin"]);

/** The video's own sources: what it plays, what it lists, and what it holds ready before a source is assigned. */
function ownSources(video: HTMLVideoElement, base: string): Candidate[] {
  const found: Candidate[] = [];
  const sources = [...video.querySelectorAll<HTMLSourceElement>(":scope > source")];
  const assigned = Boolean(video.currentSrc || video.getAttribute("src")?.trim() || sources.some(source => source.getAttribute("src")?.trim()));
  const push = (raw: string | null | undefined, mime?: string, height?: number): void => {
    const url = raw ? normalizeMediaUrl(raw.trim(), base) : null;
    if (url && worthProbing(url, { via: "element" })) found.push({ url, ...(mime ? { mime } : {}), ...(height ? { height } : {}) });
  };
  if (assigned) {
    push(video.currentSrc || video.getAttribute("src"));
    for (const source of sources) {
      const height = [...source.attributes].map(attribute => labelledHeight(attribute.value)).find(value => value !== undefined)
        ?? (/^\d{3,4}$/.test(source.getAttribute("height") ?? "") ? Number(source.getAttribute("height")) : undefined);
      push(source.getAttribute("src"), source.getAttribute("type") ?? undefined, height);
    }
    return found;
  }
  // Lazy players publish the address in another attribute first. Once a
  // standard source is assigned, such attributes may be stale.
  for (const element of [video, ...sources]) {
    const mime = element.getAttribute("type") ?? undefined;
    const height = [...element.attributes].map(attribute => labelledHeight(attribute.value)).find(value => value !== undefined);
    for (const attribute of element.attributes) {
      if (STANDARD_ATTRIBUTES.has(attribute.name)) continue;
      const item = candidate(attribute.value, base, mime && mimeKind(mime) ? mime : undefined, height);
      if (item) found.push(item);
    }
  }
  return found;
}

export interface DeclaredMedia {
  readonly byElement: ReadonlyMap<string, readonly DeclaredGroup[]>;
  readonly page: readonly DeclaredGroup[];
  readonly thumbnails: readonly string[];
  /** Pictures that are a video's still only where they lie on a player. See PageVideoMetadata. */
  readonly playerStills: readonly string[];
}

/**
 * `eligible` are the videos that may claim declarations: rendered, feeding a
 * canvas, in picture-in-picture or fullscreen, or played. Each one's container
 * is its highest ancestor below <body> that holds no other eligible video,
 * so containers are disjoint and each script is read once.
 */
export function declaredMedia(doc: Document, pageUrl: string, eligible: readonly HTMLVideoElement[], keyOf: (element: Element) => string): DeclaredMedia {
  const base = doc.baseURI === "about:blank" ? pageUrl : doc.baseURI;
  const budget = { left: SCAN_BUDGET_CHARS };
  const attributeCount = { count: 0 };
  const inside = new Map<Element, number>();
  for (const video of eligible) {
    for (let parent = parentAcrossShadow(video); parent; parent = parentAcrossShadow(parent)) inside.set(parent, (inside.get(parent) ?? 0) + 1);
  }
  const claimed = new Set<HTMLScriptElement>();
  const byElement = new Map<string, DeclaredGroup[]>();
  for (const video of eligible) {
    const key = keyOf(video);
    const collector = new Collector(`${pageUrl}#${key}`);
    collector.add("element", 0, ownSources(video, base));
    collector.addTrees("attribute", 0, jsonAttributes(video, attributeCount), base, "own");
    let container: Element = video;
    for (let parent = parentAcrossShadow(video); parent && parent !== doc.body && parent !== doc.documentElement && inside.get(parent) === 1;
      parent = parentAcrossShadow(parent)) {
      container = parent;
      collector.addTrees("attribute", 1, jsonAttributes(parent, attributeCount), base, "up");
    }
    if (container !== video) {
      container.querySelectorAll<HTMLScriptElement>("script").forEach((script, index) => {
        if (!isDataScript(script)) return;
        claimed.add(script);
        collector.addTrees("script", 2, scriptRoots(script, budget), base, `s${index}.`);
      });
    }
    byElement.set(key, collector.groups);
  }

  const page = new Collector(`${pageUrl}#page`);
  const { groups, thumbnails, playerStills } = readVideoMetadata(doc, pageUrl);
  for (const group of groups) page.add(group.via, 3, group.sources, group.primary);
  for (const link of publishedFileLinks(doc, pageUrl)) page.add("link", 3, [{ url: link.url }], link.named);
  Array.from(doc.scripts).forEach((script, index) => {
    if (claimed.has(script) || !isDataScript(script)) return;
    page.addTrees("script", 3, scriptRoots(script, budget), base, `s${index}.`);
  });

  // A page that names one file and declares one source means that source.
  // A transport stream name counts for a media element's own source and for a source with that type, never from the text alone.
  const named = declaredMediaFilename(doc, { transport: false });
  const namedWithContext = declaredMediaFilename(doc, { transport: true });
  const all = [...byElement.values(), page.groups].flat();
  const urls = new Set(all.flatMap(group => group.sources.map(source => source.url)));
  const name = (group: DeclaredGroup): DeclaredGroup => urls.size !== 1 ? group : { ...group, sources: group.sources.map(source => {
    const filenameHint = group.via === "element" || mimeKind(source.mime) === "transport" ? namedWithContext : named;
    return filenameHint ? { ...source, filenameHint } : source;
  }) };
  const linkNames = new Map(publishedFileLinks(doc, pageUrl).flatMap(link => link.filenameHint ? [[link.url, link.filenameHint] as const] : []));
  const withLinkNames = (group: DeclaredGroup): DeclaredGroup => group.via !== "link" ? group
    : { ...group, sources: group.sources.map(source => linkNames.has(source.url) ? { ...source, filenameHint: linkNames.get(source.url)! } : source) };
  return {
    byElement: new Map([...byElement].map(([key, list]) => [key, list.map(name)])),
    page: page.groups.map(name).map(withLinkNames),
    thumbnails,
    playerStills,
  };
}
