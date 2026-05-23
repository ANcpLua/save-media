import { BROWSER_OUTPUT_LIMIT_BYTES, dispatch, type StreamDescriptor, type JobError, type DispatchRefusalReason } from "@savemedia/core";
import type { DownloadJob, JobResult, ProgressFn } from "./job";
import { runDirectJob } from "./jobs/direct";
import { runHlsJob } from "./jobs/hls";
import { runDashJob } from "./jobs/dash";

export const downloadJob: DownloadJob = async (descriptor, choice, onProgress, signal) => {
  const plan = dispatch(descriptor, choice);

  if (plan.kind === "refuse") {
    throw mapRefusalToError(plan.reason, descriptor);
  }

  switch (plan.kind) {
    case "direct":
      return runDirectJob(plan, onProgress, signal);

    case "hls-plain":
    case "hls-aes":
      return runHlsJob(plan, descriptor, onProgress, signal);

    case "dash":
      return runDashJob(plan, descriptor, onProgress, signal);

  }
};

function mapRefusalToError(reason: DispatchRefusalReason, d: StreamDescriptor): JobError {
  switch (reason) {
    case "encrypted_media_detected":
      return {
        code: "encrypted_media_detected",
        severity: "terminal",
        detectedVia: d.drm?.detectedVia ?? [],
        keySystem: d.drm?.keySystem ?? null,
      };
    case "cdm_required":
      return { code: "cdm_required", severity: "terminal", keySystem: d.drm?.keySystem ?? "unknown" };
    case "clear_segments_unavailable":
      return { code: "clear_segments_unavailable", severity: "terminal", manifestUrl: d.pageUrl };
    case "license_bound_stream":
      return { code: "license_bound_stream", severity: "terminal", keyUri: "", httpStatus: 0 };
    case "clearkey_deferred":
      return { code: "clearkey_deferred", severity: "terminal", manifestUrl: d.pageUrl };
    case "no_usable_variant":
      return { code: "manifest_malformed", severity: "terminal", url: d.pageUrl, parserError: "no usable video variant" };
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
    default:
      return { code: "manifest_malformed", severity: "terminal", url: d.pageUrl, parserError: `unknown refusal: ${reason}` };
  }
}

export type { DownloadJob, JobResult, ProgressFn };
export type { StreamDescriptor, UserChoice } from "@savemedia/core";
