import type { DiscoveredMedia, MediaQuality } from "../types/messages";

const LIMIT = 80;

interface Player {
  readonly media: Map<string, DiscoveredMedia>;
  readonly groupId: string;
  priority: number;
}

/** Read the main player's literal sources, not every media URL on the page. */
export function discoverPageMedia(doc: Document, pageUrl: string): DiscoveredMedia[] {
  function add(player: Player, raw: string, height?: number): void {
    try {
      const url = new URL(raw.replace(/&amp;/g, "&"), pageUrl);
      if (!/^https?:$/.test(url.protocol) || isFragment(url.pathname)) return;
      if (!player.media.has(url.href) && player.media.size >= LIMIT) return;
      const previous = player.media.get(url.href);
      const quality: MediaQuality = { groupId: player.groupId,
        ...(height ? { height } : previous?.quality?.height ? { height: previous.quality.height } : {}) };
      player.media.set(url.href, { url: url.href, quality });
    } catch { /* Ignore malformed page data. */ }
  }

  const elements = Array.from(doc.querySelectorAll<HTMLMediaElement>("video, audio"));
  const main = elements.map(media => ({ media, score: mediaScore(media) }))
    .filter(item => item.score >= 0).sort((a, b) => b.score - a.score)[0]?.media;
  const elementPlayer: Player = { groupId: `${pageUrl}#element:${main ? elements.indexOf(main) : 0}`, media: new Map(), priority: 0 };
  if (main) {
    const media = main;
    for (const source of media.querySelectorAll("source")) {
      const height = resolution(source.getAttribute("label") ?? source.getAttribute("res") ?? source.getAttribute("size") ?? "");
      add(elementPlayer, source.src, height);
    }
    for (const raw of [media.currentSrc, media.getAttribute("src")]) if (raw) add(elementPlayer, raw);
  }

  const players = new Map<string, Player>();
  Array.from(doc.scripts).forEach((script, index) => {
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
  if (!selected) return [...elementPlayer.media.values()];
  for (const media of elementPlayer.media.values()) {
    if (![...selected.media.keys()].some(url => sameMediaUrl(url, media.url))) add(selected, media.url, media.quality?.height);
  }
  return [...selected.media.values()];
}

function sameMediaUrl(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b);
  return left.origin === right.origin && left.pathname === right.pathname;
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
    + (media.closest("main, [role=main]") ? 10 : 0) + (media.tagName === "VIDEO" ? 1 : 0);
}

function resolution(value: string): number | undefined {
  const match = /^(\d{2,5})(?:p)?$/i.exec(value.trim());
  const height = match ? Number(match[1]) : 0;
  return height > 0 && height <= 16384 ? height : undefined;
}

function isMediaUrl(raw: string, pageUrl: string): boolean {
  try { return /\.(mp4|webm|mkv|m3u8|mpd)\/?$/i.test(new URL(raw, pageUrl).pathname); }
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
