import type { JobError } from "@savemedia/core";
import { identifyResponse } from "./verify-direct";

const MARKS = {
  // RFC 8216 4.3.1.1: a playlist's first line is this tag.
  hls: (text: string): boolean => text.replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U"),
  // ISO/IEC 23009-1: the document's root element.
  dash: (text: string): boolean => /<MPD[\s>]/.test(text),
} as const;

/**
 * A playlist or manifest that is read again as its save starts must still be one. It was one when the video
 * was found; an address that now sends a web page (a sign-in page, a network's block page) or anything else
 * says so as it is, before the text is parsed: such an answer is never told as a damaged or a live playlist.
 * `url` is the address that was asked: the error names its server.
 */
export function requireManifestAtSave(kind: keyof typeof MARKS, text: string, url: string): void {
  if (MARKS[kind](text)) return;
  const identity = identifyResponse(new TextEncoder().encode(text.slice(0, 4096)), {});
  let host: string | undefined;
  try { host = new URL(url).host || undefined; } catch { host = undefined; }
  throw { code: "unexpected_media_response", severity: "terminal", response: identity.kind === "document" ? identity.response : "data",
    ...(host ? { host } : {}), atSaveStart: true } satisfies JobError;
}
