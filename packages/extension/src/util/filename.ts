import type { StreamDescriptor, OutputContainer } from "@savemedia/core";
import { MEDIA_FILE_SUFFIX } from "./media-url";

const PATH_SEPARATORS = /[/\\]/g;
// Only what file systems refuse (Windows is the strictest) plus control
// characters. Letters and digits of every script stay: a title in Japanese
// or with umlauts is a title, not garbage.
const ILLEGAL = /[<>:"|?*\u0000-\u001f]+/g;
const COLLAPSE_UNDERSCORE = /_+/g;
const COLLAPSE_WS = /\s+/g;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Turn arbitrary text into a file name, or return null when nothing usable
 * is left. "Usable" means at least one letter or digit: a title made of
 * symbols only would otherwise download as "_.mp4".
 */
export function sanitizeFilename(input: string, maxLength = 80): string | null {
  const cleaned = input
    .replace(PATH_SEPARATORS, "")
    .replace(ILLEGAL, "_")
    .replace(COLLAPSE_UNDERSCORE, "_")
    .replace(COLLAPSE_WS, " ")
    .trim()
    .slice(0, maxLength)
    .replace(TRAILING_DOTS_OR_SPACES, "");
  return HAS_WORD_CHAR.test(cleaned) ? cleaned : null;
}

const MEDIA_SUFFIX = MEDIA_FILE_SUFFIX;

/** Prefer the server's filename, then the path of the verified media response. */
export function originalMediaFilename(
  title: string | null, container: OutputContainer, ...mediaUrls: string[]
): string | null {
  const paths = mediaUrls.flatMap(url => {
    try {
      const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
      return MEDIA_SUFFIX.test(name) ? [name] : [];
    } catch { return []; }
  });
  for (const candidate of [title, ...paths]) {
    if (!candidate) continue;
    // Strip directory components and invalid characters without changing
    // intentional spaces, plus signs, Unicode, or underscores in the name.
    const basename = candidate.split(/[/\\]/).at(-1)!.replace(ILLEGAL, "_").trim();
    const extension = MEDIA_SUFFIX.exec(basename)?.[0] ?? "";
    const suffix = extension.toLowerCase();
    const stem = basename.slice(0, extension ? -extension.length : undefined).slice(0, 180)
      .replace(TRAILING_DOTS_OR_SPACES, "");
    if (!HAS_WORD_CHAR.test(stem)) continue;
    // Direct saves keep the original bytes. QuickTime and MP4 share a box
    // format, so the detected brand may differ from the publisher's suffix.
    const extensionForContainer = container === "mpegts" ? ".ts" : `.${container}`;
    const compatible = suffix === extensionForContainer || suffix === `.${container}`
      || ((container === "mp4" || container === "mov") && (suffix === ".mov" || suffix === ".mp4" || suffix === ".m4v"))
      || (container === "mpegts" && (suffix === ".mpegts" || suffix === ".m2ts"))
      || (container === "mov" && suffix === ".qt");
    return stem + (compatible ? extension : extensionForContainer);
  }
  return null;
}

export function suggestFilename(
  d: Pick<StreamDescriptor, "title" | "pageUrl"> & Partial<Pick<StreamDescriptor, "container" | "capabilities">>,
  container: OutputContainer = "mp4",
): string {
  if (d.capabilities?.directDownload) {
    if (d.container === "mov" || d.container === "webm" || d.container === "mkv" || d.container === "mpegts") container = d.container;
    const original = MEDIA_SUFFIX.test(d.title ?? "") ? originalMediaFilename(d.title, container) : null;
    if (original) return original;
  }
  const candidates = [d.title ?? "", ...titlesFromUrl(d.pageUrl), "video"];
  const suffix = container === "mpegts" ? "ts" : container;
  for (const candidate of candidates) {
    const name = sanitizeFilename(candidate.replace(MEDIA_SUFFIX, ""));
    if (name) return `${name}.${suffix}`;
  }
  return `video.${suffix}`;
}

function titlesFromUrl(pageUrl: string): string[] {
  try {
    const u = new URL(pageUrl);
    const last = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const segment = decodeURIComponent(last.replace(/\.[a-z0-9]{2,5}$/i, ""));
    return [segment, u.hostname];
  } catch {
    return [];
  }
}

const DAY_PARTS = ["1 Night", "2 Morning", "3 Afternoon", "4 Evening"] as const;

/**
 * Where a finished download lands, relative to the browser's download folder:
 * "2026-10-02 2 Morning/2026-10-02_071138.mp4". The clock at save time names
 * the file and the part of the day (six-hour blocks) groups it. The time has
 * no dashes because Finder search reads "07-11-38" as a date and finds nothing.
 */
export function timestampedPath(filename: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot).toLowerCase() : "";
  return `${day} ${DAY_PARTS[Math.floor(now.getHours() / 6)]}/${day}_${time}${ext}`;
}
