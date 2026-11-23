import { formatBytes, type StreamDescriptor, type Variant } from "@savemedia/core";

export { formatBytes };

/** The bytes a save will write: exact when the server declared the file's length, else an estimate. */
export interface ExpectedSize {
  readonly bytes: number;
  readonly exact: boolean;
}

/**
 * Byte total declared by a probe response: the total of a 206's
 * `content-range` (probes are range-limited), else plain `content-length`.
 * An unknown (`*`) or unparsable total yields null, so the size stays
 * unknown rather than wrong.
 */
export function declaredTotalBytes(headers: Readonly<Record<string, string>>): number | null {
  const contentRange = headers["content-range"];
  const raw = contentRange === undefined
    ? headers["content-length"]
    : /\/(\d+)\s*$/.exec(contentRange)?.[1];
  const total = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/**
 * The size a save of `variant` will have. A direct file reports the length
 * its server declared. A stream uses its manifest's estimate, else its bit
 * rate over the playing video's duration. HLS declares a peak bit rate, so
 * that estimate leans high. Without either, the size is unknown.
 */
export function expectedSize(
  descriptor: StreamDescriptor,
  variant: Variant | undefined,
  durationSeconds?: number | null,
): ExpectedSize | null {
  if (descriptor.source.kind === "direct-url" && descriptor.capabilities.directDownload) {
    const declared = declaredTotalBytes(descriptor.source.headers) ?? variant?.estimatedSize ?? null;
    if (declared) return { bytes: declared, exact: true };
  }
  if (!variant) return null;
  // A separate audio track adds its own bytes to the saved file.
  const audio = variant.audioRenditionId === null ? null
    : descriptor.audioRenditions?.find(rendition => rendition.audioRenditionId === variant.audioRenditionId) ?? null;
  if (variant.estimatedSize) return { bytes: variant.estimatedSize + (audio?.estimatedSize ?? 0), exact: false };
  if (variant.bitrate && durationSeconds && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return { bytes: Math.round(variant.bitrate / 8 * durationSeconds), exact: false };
  }
  return null;
}

/** "245.3 MB" when exact, "~245.3 MB" when estimated. */
export function sizeText(size: ExpectedSize): string {
  return `${size.exact ? "" : "~"}${formatBytes(size.bytes)}`;
}
