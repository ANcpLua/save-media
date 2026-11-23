// Shared rules for media addresses. They only decide what is worth a probe:
// the probe's bytes decide what is offered. This module imports nothing, so
// the classic content scripts can inline it.

export type MediaKind = "manifest" | "file" | "transport";

const SUFFIX_KIND: Readonly<Record<string, MediaKind>> = {
  m3u8: "manifest", mpd: "manifest",
  mp4: "file", m4v: "file", mov: "file", qt: "file", webm: "file", mkv: "file",
  ts: "transport", mpegts: "transport", m2ts: "transport",
};

/** File and transport suffixes, for file names. */
export const MEDIA_FILE_SUFFIX = /\.(mp4|m4v|mov|qt|webm|mkv|ts|mpegts|m2ts)$/i;

const MANIFEST_MIMES = new Set(["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl", "application/dash+xml"]);

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Built from the suffixes and playlist types above, so a suffix added there is also seen here.
// Transport suffixes are left out: a declared address with one is never probed without a type.
const DECLARES_MEDIA = new RegExp(`\\.(?:${Object.keys(SUFFIX_KIND).filter(suffix => SUFFIX_KIND[suffix] !== "transport").map(escaped).join("|")})(?![a-z0-9])`
  + `|video\\\\?/|${[...MANIFEST_MIMES].map(mime => escaped(mime).replace("\\/", "\\\\?\\/")).join("|")}`, "i");

/**
 * Whether a text can declare media at all: it names a media suffix, a video
 * type or a playlist type (also with the slash escaped, as in JSON). A cheap
 * gate before a script is read; what it lets through is still parsed and probed.
 */
export function mayDeclareMedia(text: string): boolean {
  return DECLARES_MEDIA.test(text);
}

/** A playlist or manifest type: HLS or DASH. */
export function isManifestMime(mime: string | null | undefined): boolean {
  return MANIFEST_MIMES.has((mime ?? "").split(";", 1)[0]!.trim().toLowerCase());
}

/**
 * The longest media address savemedia works with: the length a page's own
 * messages may name. A longer one is not checked, listed or stored.
 */
export const MAX_ADDRESS_LENGTH = 8192;

export function withoutHash(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

/** An absolute http(s) address without credentials or fragment, or null. */
export function normalizeMediaUrl(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/** The kind the last path segment's suffix names. "/clip.mp4/" names none. */
export function urlKind(url: string): MediaKind | null {
  let path: string;
  try { path = new URL(url, "http://local.invalid/").pathname; } catch { return null; }
  const segment = path.slice(path.lastIndexOf("/") + 1);
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return null;
  return SUFFIX_KIND[segment.slice(dot + 1).toLowerCase()] ?? null;
}

export function mimeKind(mime: string | null | undefined): MediaKind | null {
  const type = (mime ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (!type) return null;
  if (MANIFEST_MIMES.has(type)) return "manifest";
  if (type === "video/mp2t") return "transport";
  // The registered type of a fragment, never of a whole file.
  if (type === "video/iso.segment") return null;
  return type.startsWith("video/") ? "file" : null;
}

/** The containers a file of each suffix holds. Fragmented and CMAF files are MP4 files. */
const SUFFIX_CONTAINERS: Readonly<Record<string, readonly string[]>> = {
  mp4: ["mp4", "fmp4", "cmaf"], m4v: ["mp4", "fmp4", "cmaf"], mov: ["mov"], qt: ["mov"], webm: ["webm"], mkv: ["mkv"],
  ts: ["mpegts"], mpegts: ["mpegts"], m2ts: ["mpegts"],
};

/**
 * Whether a file with this name can be a file of this container, as its bytes
 * were read. A name alone never says what a file is: this is the check that
 * lets a name the page shows stand for a file the browser received. A page
 * that names "Movie.mkv" and plays an MP4 preview of it has not sent Movie.mkv.
 */
export function nameFitsContainer(name: string, container: string): boolean {
  const suffix = MEDIA_FILE_SUFFIX.exec(name.trim())?.[1]?.toLowerCase();
  return suffix !== undefined && (SUFFIX_CONTAINERS[suffix]?.includes(container) ?? false);
}

/** A media file name: at most 240 characters, no path separators or control characters. */
export function mediaFileName(name: string | null | undefined): string | undefined {
  const value = name?.trim();
  return value && value.length <= 240 && !/[/\\\u0000-\u001f]/.test(value) && MEDIA_FILE_SUFFIX.test(value) ? value : undefined;
}

/** The file name a Content-Disposition header states, decoded, or undefined. */
export function dispositionFileName(disposition: string | null | undefined): string | undefined {
  if (!disposition) return undefined;
  const extended = /filename\*\s*=\s*(?:UTF-8|ISO-8859-1)?'[^']*'([^;]*)/i.exec(disposition)?.[1]?.trim();
  if (extended) {
    try { return decodeURIComponent(extended); } catch { /* fall through to the plain parameter */ }
  }
  const plain = /filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i.exec(disposition);
  const value = (plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2])?.trim();
  return value || undefined;
}

export type Seen =
  | { readonly via: "element" }
  | { readonly via: "declared"; readonly mime?: string | undefined }
  /** `mime` undefined: the request has no response yet. An empty string: a response without a type. */
  | { readonly via: "request"; readonly type: string; readonly mime?: string | undefined; readonly disposition?: string | undefined };

/**
 * Whether an answer to a page's own fetch or XHR may be a whole video file that the page then plays from
 * memory (a Blob address): a full answer (200, not a range) with a video type. worthProbing leaves such
 * an answer alone, because a player that is fed piece by piece fetches its parts the same way, and a
 * check of every part would be a request per part. So it is only noted. When the user looks at the page
 * and a player there plays from memory with nothing else known as its video, the noted answers of its
 * document are checked, and their first bytes tell a whole file from a part (core's beginsWholeMediaFile).
 * A transport stream is left out: a browser plays none from memory, so a fetched one is a part.
 */
export function mayBeFetchedFile(url: string, seen: { readonly type: string; readonly status: number; readonly mime: string | undefined }): boolean {
  return seen.type === "xmlhttprequest" && seen.status === 200 && normalizeMediaUrl(url) !== null && mimeKind(seen.mime) === "file";
}

/** Whether a probe of this address is worth a request. Only http(s) ever is. */
export function worthProbing(url: string, seen: Seen): boolean {
  if (normalizeMediaUrl(url) === null) return false;
  if (seen.via === "element") return true;
  const named = urlKind(url);
  if (seen.via === "declared") return mimeKind(seen.mime) !== null || named === "manifest" || named === "file";
  if (seen.type !== "media" && seen.type !== "xmlhttprequest") return false;
  if (named === "manifest") return true;
  if (seen.mime === undefined) return false;
  const kind = mimeKind(seen.mime);
  const type = seen.mime.split(";", 1)[0]!.trim().toLowerCase();
  if (seen.type === "media") return kind !== null || type === "" || type === "application/octet-stream";
  if (kind === "manifest") return true;
  if (!/^\s*attachment\b/i.test(seen.disposition ?? "")) return false;
  return kind !== null || mediaFileName(dispositionFileName(seen.disposition)) !== undefined;
}

/** The webRequest type a resource timing entry's initiator corresponds to. */
export function requestTypeOfTiming(initiatorType: string): "media" | "xmlhttprequest" | null {
  if (initiatorType === "video" || initiatorType === "audio") return "media";
  return initiatorType === "fetch" || initiatorType === "xmlhttprequest" ? "xmlhttprequest" : null;
}

/**
 * The identity of a playlist or manifest across reloads: its address without
 * the fragment and without the delivery directives the HLS specification
 * reserves (query parameters whose names start with `_HLS_`). A protocol
 * rule, not a site's parameter list.
 */
export function playlistIdentity(url: string): string {
  const plain = withoutHash(url);
  if (!plain.includes("_HLS_")) return plain;
  try {
    const parsed = new URL(plain);
    for (const name of [...parsed.searchParams.keys()]) if (name.startsWith("_HLS_")) parsed.searchParams.delete(name);
    return parsed.href;
  } catch { return plain; }
}
