import type { DiscoveredMedia, MediaQuality } from "../types/messages";
import { readVideoMetadata, resolution } from "./video-metadata";

const LIMIT = 80;

interface Player {
  readonly media: Map<string, DiscoveredMedia>;
  readonly groupId: string;
  priority: number;
}

/** Read the main player's literal sources, not every media URL on the page. */
export function discoverPageMedia(doc: Document, pageUrl: string): DiscoveredMedia[] {
  const base = doc.baseURI === "about:blank" ? pageUrl : doc.baseURI;
  function add(player: Player, raw: string, height?: number): void {
    try {
      const url = new URL(raw.replace(/&amp;/g, "&"), base);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || isFragment(url.pathname)) return;
      url.hash = "";
      if (!player.media.has(url.href) && player.media.size >= LIMIT) return;
      const previous = player.media.get(url.href);
      const quality: MediaQuality = { groupId: player.groupId,
        ...(height ? { height } : previous?.quality?.height ? { height: previous.quality.height } : {}) };
      player.media.set(url.href, { url: url.href, quality });
    } catch { /* Ignore malformed page data. */ }
  }

  const elements = Array.from(doc.querySelectorAll<HTMLVideoElement>("video"));
  const main = elements.map(media => ({ media, score: mediaScore(media) }))
    .filter(item => item.score >= 0).sort((a, b) => b.score - a.score)[0]?.media;
  const elementPlayer: Player = { groupId: `${pageUrl}#element:${main ? elements.indexOf(main) : 0}`, media: new Map(), priority: 0 };
  if (main) {
    const src = main.getAttribute("src");
    if (src) add(elementPlayer, src);
    for (const source of main.querySelectorAll<HTMLSourceElement>("source[src]")) {
      const height = ["height", "label", "res", "size", "data-height", "data-quality"]
        .map(key => resolution(source.getAttribute(key))).find(value => value !== undefined);
      add(elementPlayer, source.getAttribute("src")!, height);
    }
    if (main.currentSrc) add(elementPlayer, main.currentSrc, resolution(main.videoHeight));
  }

  const players = new Map<string, Player>();
  Array.from(doc.scripts).forEach((script, index) => {
    if (script.type.toLowerCase() === "application/ld+json") return;
    for (const object of literalObjects((script.textContent ?? "").slice(0, 2_000_000))) {
      if (object.path.some(key => /^(related|recommend|preview|thumb|advert|ads$)/i.test(key))) continue;
      const groupId = `${pageUrl}#config:${index}:${object.group}`;
      let player = players.get(groupId);
      if (!player) {
        player = { groupId, media: new Map(), priority: 0 };
        players.set(groupId, player);
      }
      for (const [key, raw] of Object.entries(object.fields)) {
        if (!/^(video_url|video_alt_url\d*)$/.test(key)) continue;
        if (/^(1|true)$/i.test(object.fields[`${key}_redirect`] ?? "")) continue;
        if (!isMediaUrl(raw, pageUrl)) continue;
        const height = resolution(object.fields[`${key}_text`] ?? "");
        add(player, raw, height);
        player.priority = 3;
      }
      const sourceContext = object.path.some(key => /^(sources?|streams?|urls?|player|config)$/i.test(key));
      const raw = object.fields["file"] ?? object.fields["src"] ?? (sourceContext ? object.fields["url"] : undefined);
      if (raw && isMediaUrl(raw, pageUrl)) {
        const height = resolution(object.fields["label"] ?? object.fields["height"] ?? object.fields["res"] ?? "");
        if (object.fields["file"] || sourceContext || height) {
          add(player, raw, height);
          player.priority = Math.max(player.priority, 2);
        }
      }
      if (/^(sources|urls)$/i.test(object.path.at(-1) ?? "")) {
        for (const [label, url] of Object.entries(object.fields)) {
          const height = resolution(label);
          if (height && isMediaUrl(url, pageUrl)) { add(player, url, height); player.priority = Math.max(player.priority, 2); }
        }
      }
    }
  });

  const configs = [...players.values()].filter(player => player.media.size > 0);
  const matched = configs.filter(player => [...player.media.keys()].some(url =>
    [...elementPlayer.media.keys()].some(elementUrl => sameMediaUrl(url, elementUrl))));
  // A live element identifies its own config. Before the player creates one,
  // prefer the explicit video config, then a source list, in document order.
  const pool = matched.length ? matched : elementPlayer.media.size ? [] : configs;
  const selected = pool.sort((a, b) => b.priority - a.priority)[0];
  if (selected) {
    for (const media of elementPlayer.media.values()) {
      if (![...selected.media.keys()].some(url => sameMediaUrl(url, media.url))) add(selected, media.url, media.quality?.height);
    }
  }
  let player = selected ?? elementPlayer;
  const groups = readVideoMetadata(doc, pageUrl);
  // Relate renditions by an actual shared source URL or a publisher's explicit
  // WebPage.mainEntity. A nearby VideoObject can describe a different clip.
  const overlaps = (url: string) => player.media.has(url.split("#")[0]!);
  let related = groups.filter(group => group.sources.some(({ url }) => overlaps(url)));
  if (!related.length) {
    const primary = groups.filter(group => group.primary);
    const choices = primary.length ? primary : player.media.size ? [] : groups;
    const first = choices[0];
    const firstUrls = new Set(first?.sources.map(source => source.url.split("#")[0]));
    const standalone = choices.every(group => group.sources.some(({ url }) => firstUrls.has(url.split("#")[0]))) ? first : undefined;
    if (standalone) {
      player = { groupId: `${pageUrl}#metadata:${groups.indexOf(standalone)}`, media: new Map(), priority: 0 };
      for (const source of standalone.sources) add(player, source.url, source.height);
      related = groups.filter(group => group.sources.some(({ url }) => overlaps(url)));
    }
  }
  for (const group of related) {
    for (const source of group.sources) add(player, source.url, source.height);
  }
  const media = [...player.media.values()];
  // Some file pages show the filename while serving an opaque player URL.
  // Apply a literal filename only when the page offers one media candidate.
  const published = publishedMediaLinks(doc, pageUrl);
  // A named file page can play a preview while offering the original separately.
  // Its explicit file links are authoritative. On a collection without a player,
  // each link is a separate choice.
  if (published.length && (!media.length || declaredMediaFilename(doc))) return published;
  if (media.length === 1) {
    const filenameHint = declaredMediaFilename(doc);
    if (filenameHint) return [{ ...media[0]!, filenameHint }];
  }
  return media;
}

/** HTML's download attribute can name a file even when the URL has no suffix. */
export function mediaFilename(value: string | null): string | undefined {
  const name = value?.trim();
  return name && name.length <= 240 && !/[/\\\u0000-\u001f]/.test(name)
    && /\.(mp4|mov|qt|webm|mkv)$/i.test(name) ? name : undefined;
}

export function fileLinkName(link: HTMLAnchorElement, url: URL): string | undefined {
  const promised = mediaFilename(link.getAttribute("download"));
  if (promised) return promised;
  try { return mediaFilename(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")); }
  catch { return undefined; }
}

export function publishedMediaLinks(doc: Document, pageUrl: string): DiscoveredMedia[] {
  const declared = declaredMediaFilename(doc);
  const files = new Map<string, DiscoveredMedia>();
  for (const link of doc.querySelectorAll<HTMLAnchorElement>("a[download][href], a[type^='video/' i][href]")) {
    if (link.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')) continue;
    const style = doc.defaultView?.getComputedStyle(link);
    if (style?.display === "none" || style?.visibility === "hidden") continue;
    try {
      const url = new URL(link.getAttribute("href")!, doc.baseURI === "about:blank" ? pageUrl : doc.baseURI);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href === pageUrl || link.getAttribute("href")?.startsWith("#")) continue;
      const name = fileLinkName(link, url);
      if (name && declared && name !== declared) continue;
      const filenameHint = name ?? declared;
      if (filenameHint || link.type.toLowerCase().startsWith("video/")) {
        files.set(url.href, { url: url.href, ...(filenameHint ? { filenameHint } : {}) });
      }
      if (files.size >= LIMIT) break;
    } catch { /* Ignore invalid publisher links. */ }
  }
  return [...files.values()];
}

export function declaredMediaFilename(doc: Document): string | undefined {
  return [...doc.querySelectorAll('h1, meta[property="og:title"]')]
    .map(el => (el.getAttribute("content") ?? el.textContent ?? "").trim())
    .map(mediaFilename).find(name => name !== undefined);
}

function sameMediaUrl(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  left.hash = "";
  right.hash = "";
  return left.href === right.href;
}

function mediaScore(media: HTMLMediaElement): number {
  const view = media.ownerDocument.defaultView;
  for (let element: HTMLElement | null = media; element; element = element.parentElement) {
    const style = view?.getComputedStyle(element);
    if (element.hidden || element.getAttribute("aria-hidden") === "true" || style?.display === "none" || style?.visibility === "hidden") return -1;
  }
  const rect = media.getBoundingClientRect();
  const visibleWidth = Math.max(0, Math.min(rect.right, view?.innerWidth ?? rect.right) - Math.max(0, rect.left));
  const visibleHeight = Math.max(0, Math.min(rect.bottom, view?.innerHeight ?? rect.bottom) - Math.max(0, rect.top));
  return visibleWidth * visibleHeight * 1000 + (media.controls ? 100 : 0)
    + (media.closest("main, [role=main]") ? 10 : 0);
}

function isMediaUrl(raw: string, pageUrl: string): boolean {
  try { return /\.(mp4|mov|qt|webm|mkv|m3u8|mpd)\/?$/i.test(new URL(raw, pageUrl).pathname); }
  catch { return false; }
}

function isFragment(path: string): boolean {
  const base = path.split("/").filter(Boolean).at(-1) ?? path;
  return /\.(m4s|ts|mpegts)$/i.test(base)
    || /\.mp4\/[^/]+\.(mp4|m4s)$/i.test(path)
    || /^(init|seg|segment|chunk|frag|fragment|part)(?:[._-][a-z0-9._-]*)?\.mp4$/i.test(base);
}

interface LiteralObject { fields: Record<string, string>; group: number; path: readonly string[] }

/** Tokenize quoted literals and nesting so adjacent players never get merged. */
function literalObjects(text: string): LiteralObject[] {
  const tokens = Array.from(text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[{}\[\]:,=]/g))
    .filter(t => !t[0].startsWith("/*") && !t[0].startsWith("//"));
  const stack: { type: string; start: number; fields: Record<string, string>; group: number; path: readonly string[] }[] = [];
  const result: LiteralObject[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const value = token[0];
    if (value === "{" || value === "[") {
      const parent = stack.at(-1);
      const previous = tokens[i - 1]?.[0];
      const key = previous === ":" || previous === "=" ? decodeLiteral(tokens[i - 2]?.[0] ?? "") : "";
      const path = key ? [...(parent?.path ?? []), key] : parent?.path ?? [];
      const sharedSources = /^(sources|urls)$/i.test(key);
      const sourceArray = parent?.type === "[" && /^(sources|urls)$/i.test(parent.path.at(-1) ?? "");
      stack.push({ type: value, start: token.index!, fields: Object.create(null) as Record<string, string>,
        path, group: parent && (sourceArray || sharedSources) ? parent.group : token.index! });
    } else if (value === "}" || value === "]") {
      const frame = stack.pop();
      if (frame?.type === "{" && value === "}") result.push(frame);
    } else if (stack.at(-1)?.type === "{" && tokens[i + 1]?.[0] === ":") {
      const literal = tokens[i + 2]?.[0];
      if (literal && /^(?:["']|\d|true$|false$|null$)/.test(literal)) {
        stack.at(-1)!.fields[decodeLiteral(value)] = decodeLiteral(literal);
        i += 2;
      }
    }
  }
  return result;
}

function decodeLiteral(value: string): string {
  if (!/^["']/.test(value)) return value;
  return value.slice(1, -1).replace(/\\(?:u([\da-f]{4})|x([\da-f]{2})|([\s\S]))/gi,
    (_all, unicode: string | undefined, hex: string | undefined, char: string | undefined) =>
      unicode || hex ? String.fromCharCode(parseInt(unicode ?? hex!, 16)) : ({ n: "\n", r: "\r", t: "\t" }[char ?? ""] ?? char ?? ""));
}
