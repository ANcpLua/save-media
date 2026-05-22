import type { StreamDescriptor, OutputContainer } from "@savemedia/core";

const PATH_SEPARATORS = /[/\\]/g;
const ILLEGAL = /[^a-zA-Z0-9._\- ]+/g;
const COLLAPSE_UNDERSCORE = /_+/g;
const COLLAPSE_WS = /\s+/g;
const TRAILING_DOTS = /\.+$/;

export function sanitizeFilename(input: string, maxLength = 80): string {
  const cleaned = input
    .replace(PATH_SEPARATORS, "")
    .replace(ILLEGAL, "_")
    .replace(COLLAPSE_UNDERSCORE, "_")
    .replace(COLLAPSE_WS, " ")
    .trim()
    .slice(0, maxLength)
    .replace(TRAILING_DOTS, "");
  return cleaned.length > 0 ? cleaned : "video";
}

export function suggestFilename(
  d: Pick<StreamDescriptor, "title" | "pageUrl">,
  container: OutputContainer = "mp4",
): string {
  const raw = (d.title ?? deriveTitleFromUrl(d.pageUrl)) || "video";
  return `${sanitizeFilename(raw)}.${container}`;
}

function deriveTitleFromUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    const last = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return decodeURIComponent(last.replace(/\.[a-z0-9]{2,5}$/i, "")) || u.hostname;
  } catch {
    return "video";
  }
}
