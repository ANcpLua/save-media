import {
  BROWSER_OUTPUT_LIMIT_BYTES,
  type DispatchRefusalReason,
  type JobError,
  type StreamDescriptor,
} from "@savemedia/core";

export function dispatchRefusalToError(reason: DispatchRefusalReason, d: StreamDescriptor): JobError {
  const drm = d.drm;
  switch (reason) {
    case "encrypted_media_detected":
      return {
        code: "encrypted_media_detected",
        severity: "terminal",
        detectedVia: drm?.detectedVia ?? [],
        keySystem: drm?.keySystem ?? null,
      };
    case "cdm_required":
      return { code: "cdm_required", severity: "terminal", keySystem: drm?.keySystem ?? "unknown" };
    case "clear_segments_unavailable":
      return { code: "clear_segments_unavailable", severity: "terminal", manifestUrl: d.pageUrl };
    case "license_bound_stream":
      return { code: "license_bound_stream", severity: "terminal", keyUri: "", httpStatus: 0 };
    case "clearkey_deferred":
      return { code: "clearkey_deferred", severity: "terminal", manifestUrl: d.pageUrl };
    case "no_usable_variant":
      return {
        code: "manifest_malformed",
        severity: "terminal",
        url: d.pageUrl,
        parserError: "no usable video variant",
      };
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
        estimatedBytes: Math.max(...d.variants.map(v => v.estimatedSize ?? 0), 0),
        limitBytes: BROWSER_OUTPUT_LIMIT_BYTES,
      };
    case "dash_unsupported":
      return {
        code: "dash_unsupported",
        severity: "terminal",
        manifestUrl: d.source.kind === "dash-manifest" ? d.source.manifestUrl : d.pageUrl,
      };
    case "hls_encryption_unsupported":
      return {
        code: "hls_encryption_unsupported",
        severity: "terminal",
        manifestUrl: d.source.kind === "hls-manifest" ? d.source.manifestUrl : d.pageUrl,
        method: "AES-128",
      };
    case "hls_live_unsupported":
      return {
        code: "hls_live_unsupported",
        severity: "terminal",
        manifestUrl: d.source.kind === "hls-manifest" ? d.source.manifestUrl : d.pageUrl,
      };
  }
}
