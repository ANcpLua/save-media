import { dispatch, type StreamDescriptor, type JobError } from "@savemedia/core";
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
      if (plan.useNativeSink) throw tooLargeForRenderer(descriptor, plan.outputContainer);
      return runHlsJob(plan, descriptor, onProgress, signal);

    case "dash":
      if (plan.useNativeSink) throw tooLargeForRenderer(descriptor, plan.outputContainer);
      return runDashJob(plan, descriptor, onProgress, signal);

    case "remux":
    case "transcode":
      // No in-browser transcode path any more (ffmpeg.wasm + native
      // ffmpeg both gone). Surface the gap to the user clearly.
      throw {
        code: "no_remux_path",
        severity: "terminal",
        from: descriptor.container,
        to: plan.outputContainer,
        reason: "container-not-supported-by-mediabunny",
      } satisfies JobError;
  }
};

/**
 * Used when the dispatched plan flagged useNativeSink (estimated
 * output ≥ 2 GiB). The renderer's Blob ceiling can't hold a file
 * that size and we no longer have a native streaming sink to fall
 * back on. Tell the user instead of OOMing the offscreen page.
 */
function tooLargeForRenderer(
  d: StreamDescriptor,
  to: "mp4" | "webm" | "mkv",
): JobError {
  return {
    code: "no_remux_path",
    severity: "terminal",
    from: d.container,
    to,
    reason: "container-not-supported-by-mediabunny",
  };
}

function mapRefusalToError(reason: string, d: StreamDescriptor): JobError {
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
    default:
      return { code: "manifest_malformed", severity: "terminal", url: d.pageUrl, parserError: `unknown refusal: ${reason}` };
  }
}

export type { DownloadJob, JobResult, ProgressFn };
export type { StreamDescriptor, UserChoice } from "@savemedia/core";
