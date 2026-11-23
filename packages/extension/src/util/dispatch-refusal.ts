import {
  BROWSER_OUTPUT_LIMIT_BYTES,
  type DispatchRefusal,
  type DispatchRefusalReason,
  type JobError,
  type StreamDescriptor,
} from "@savemedia/core";
import { sourceAddress } from "./media-address";

/**
 * `details`: what dispatch said with the refusal (DispatchRefusal). With output_too_large_for_browser, the
 * size it compared with the limit; with codec_unsupported, the codec and its track.
 */
export function dispatchRefusalToError(reason: DispatchRefusalReason, d: StreamDescriptor,
  details: Pick<DispatchRefusal, "estimatedBytes" | "codec"> = {}): JobError {
  const { estimatedBytes, codec } = details;
  switch (reason) {
    case "cdm_required":
      // Where the protection was declared travels with the refusal, so every surface describes it the same way.
      return { code: "cdm_required", severity: "terminal", keySystem: d.drm?.keySystem ?? "unknown", ...(d.drm ? { detectedVia: d.drm.detectedVia } : {}) };
    case "clearkey_deferred":
      return { code: "clearkey_deferred", severity: "terminal", manifestUrl: manifestOf(d), ...(d.drm ? { detectedVia: d.drm.detectedVia } : {}) };
    case "no_usable_variant":
      return {
        code: "manifest_malformed",
        severity: "terminal",
        url: manifestOf(d),
        parserError: "no usable video variant",
      };
    case "codec_unsupported":
      return { code: "codec_unsupported", severity: "terminal", manifestUrl: manifestOf(d), track: codec?.track ?? "audio", codec: codec?.family ?? "unknown" };
    case "unsupported_output":
      return {
        code: "unsupported_output",
        severity: "terminal",
        from: d.container,
        to: d.container === "webm" || d.container === "mkv" ? d.container : "mp4",
        reason: "conversion-not-implemented",
      };
    case "output_too_large_for_browser":
      return {
        code: "output_too_large_for_browser",
        severity: "terminal",
        // The size of the whole save, video and audio together, as dispatch added it up. Without it, the largest video track.
        estimatedBytes: estimatedBytes ?? Math.max(...d.variants.map(v => v.estimatedSize ?? 0), 0),
        limitBytes: BROWSER_OUTPUT_LIMIT_BYTES,
      };
    case "dash_unsupported":
      return {
        code: "dash_unsupported",
        severity: "terminal",
        manifestUrl: manifestOf(d),
      };
    case "hls_encryption_unsupported":
      return {
        code: "hls_encryption_unsupported",
        severity: "terminal",
        manifestUrl: manifestOf(d),
        method: "AES-128",
      };
    case "hls_live_unsupported":
      return {
        code: "hls_live_unsupported",
        severity: "terminal",
        manifestUrl: manifestOf(d),
      };
  }
}

/** The stream's own address, as savemedia asks for it, whose host the failure names. Never the page's: the page is not the server that was asked. */
const manifestOf = (d: StreamDescriptor): string => sourceAddress(d, "entry");
