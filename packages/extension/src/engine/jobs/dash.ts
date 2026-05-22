import type { DashPlan, StreamDescriptor } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";

/**
 * DASH download stub. The full implementation needs SegmentTemplate /
 * SegmentTimeline / SegmentBase parsing, init-segment fetch, init+media
 * concatenation, and audio-rendition handling — see Task 3 in the plan.
 *
 * For now we surface a clear no_remux_path error so callers can route to the
 * native host fallback or ffmpeg.wasm path; we do not silently succeed.
 */
export async function runDashJob(
  _plan: DashPlan,
  descriptor: StreamDescriptor,
  _onProgress: ProgressFn,
  _signal: AbortSignal,
): Promise<JobResult> {
  throw {
    code: "no_remux_path",
    severity: "terminal",
    from: descriptor.container,
    to: "mp4",
    reason: "container-not-supported-by-mediabunny",
  };
}
