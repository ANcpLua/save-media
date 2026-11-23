import type { JobError } from "../errors/taxonomy";

/**
 * The most segments one representation, and one whole manifest, may expand
 * to. A manifest of a few hundred bytes can declare millions of segments
 * (a one-millisecond SegmentTemplate over hours), and expanding it would
 * freeze or kill the service worker. Real streams stay far below: a
 * twenty-four hour recording in two-second segments has 43,200.
 */
export const MAX_SEGMENTS_PER_TRACK = 100_000;
export const MAX_SEGMENTS_PER_MANIFEST = 400_000;

/**
 * The most base address combinations a DASH manifest may declare. The parser
 * multiplies the BaseURL elements of every level, so a few hundred bytes of
 * them can stand for millions of representations.
 */
export const MAX_DASH_BASE_URL_COMBINATIONS = 50_000;

/** The most bytes of a manifest that are read at all. */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/**
 * The most address text one manifest may resolve to: its variant, init and
 * segment addresses together. A relative name is joined to the manifest's
 * own address, so a short playlist under a long address can stand for
 * hundreds of megabytes of text. Real streams stay far below: a three-hour
 * film in two-second segments, at 150 characters an address and in eight
 * renditions, resolves to under 7 MiB.
 */
export const MAX_MANIFEST_ADDRESS_BYTES = 32 * 1024 * 1024;

export function manifestTooLarge(url: string, limit: "bytes" | "segments"): JobError {
  return { code: "manifest_too_large", severity: "terminal", url, limit };
}

/**
 * Counts the address text a manifest resolves to. The returned function
 * hands each address back, and throws manifest_too_large as soon as the
 * manifest holds more than the limit, before the rest is resolved.
 */
export function addressBudget(url: string, limit: number = MAX_MANIFEST_ADDRESS_BYTES): (address: string) => string {
  let used = 0;
  return address => {
    used += address.length;
    if (used > limit) throw manifestTooLarge(url, "segments");
    return address;
  };
}

/** Segment lines of an HLS playlist: every line that is not a tag, a comment or empty. */
export function hlsSegmentLines(text: string): number {
  let count = 0;
  let at = 0;
  while (at < text.length) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    let start = at;
    while (start < end && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9 || text.charCodeAt(start) === 13)) start++;
    if (start < end && text.charCodeAt(start) !== 35 /* # */) count++;
    at = end + 1;
  }
  return count;
}

/** Seconds of an ISO 8601 duration such as PT1H30M or P1DT2S. Null when it is not one. */
export function isoDurationSeconds(value: string | null | undefined): number | null {
  const match = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
    .exec((value ?? "").trim());
  if (!match) return null;
  const [years, months, days, hours, minutes, seconds] = match.slice(1).map(part => Number(part ?? 0));
  return years! * 31_536_000 + months! * 2_592_000 + days! * 86_400 + hours! * 3_600 + minutes! * 60 + seconds!;
}

/**
 * Throws manifest_too_large for a manifest text that is too long, and for an
 * HLS playlist with too many segment lines. A DASH manifest's segments are
 * counted inside parseDash, from the parser's own stage before expansion,
 * because its text alone does not say what the parser builds from it.
 */
export function checkManifestSize(protocol: "hls" | "dash", text: string, url: string): void {
  if (text.length > MAX_MANIFEST_BYTES) throw manifestTooLarge(url, "bytes");
  if (protocol === "hls" && hlsSegmentLines(text) > MAX_SEGMENTS_PER_TRACK) throw manifestTooLarge(url, "segments");
}
