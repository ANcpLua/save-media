import { dispatch, type StreamDescriptor, type JobError } from "@savemedia/core";
import type { DownloadJob, JobResult, ProgressFn } from "./job";
import { runDirectJob } from "./jobs/direct";
import { runHlsJob } from "./jobs/hls";
import { runDashJob } from "./jobs/dash";
import { runTranscodeJob } from "./jobs/transcode";
import type { FFmpegLoaderDeps } from "./transcode/ffmpeg-loader";

function defaultFFmpegDeps(): FFmpegLoaderDeps {
  return {
    getURL: (path) => chrome.runtime.getURL(path),
  };
}

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
    case "remux":
    case "transcode": {
      if (descriptor.source.kind !== "direct-url") {
        throw {
          code: "no_remux_path",
          severity: "terminal",
          from: descriptor.container,
          to: plan.outputContainer,
          reason: "container-not-supported-by-mediabunny",
        } satisfies JobError;
      }
      onProgress(0, null, "fetching-source");
      const resp = await fetch(descriptor.source.url, { signal });
      if (!resp.ok) {
        throw {
          code: "manifest_404",
          severity: "terminal",
          url: descriptor.source.url,
          httpStatus: resp.status,
        } satisfies JobError;
      }
      const sourceBytes = new Uint8Array(await resp.arrayBuffer());
      return runTranscodeJob(
        plan,
        { sourceBytes, sourceFilename: choice.filename },
        onProgress,
        signal,
        defaultFFmpegDeps(),
      );
    }
  }
};

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
// re-export for test/typing ergonomics
// (kept here so consumers don't need to know the file split)
export type { StreamDescriptor, UserChoice } from "@savemedia/core";
