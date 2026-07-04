import type { StreamDescriptor, Variant } from "@savemedia/core";

/**
 * A descriptor dispatch can actually turn into an av-merge plan: dash
 * protocol with at least one video variant and one audio rendition whose
 * segment refs carry concrete media URLs. parseDash leaves dynamic/live and
 * byte-range MPDs unmaterialized, so length checks alone would admit
 * descriptors that can only refuse.
 */
export function hasDownloadableDemuxedPair(d: StreamDescriptor): boolean {
  return d.protocol === "dash"
    && d.variants.some(isMaterialized)
    && (d.audioRenditions ?? []).some(isMaterialized);
}

function isMaterialized(v: Variant): boolean {
  return v.segmentRef.kind === "dash-segments" && v.segmentRef.mediaUrls.length > 0;
}
