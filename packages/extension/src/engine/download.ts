import { dispatch } from "@savemedia/core";
import type { DownloadJob, JobResult, ProgressFn } from "./job";
import { runDirectJob } from "./jobs/direct";
import { runHlsJob } from "./jobs/hls";
import { runAvMergeJob } from "./jobs/av-merge";
import { materializeDemuxedHls } from "./parsers/hls";
import { dispatchRefusalToError } from "../util/dispatch-refusal";

export const downloadJob: DownloadJob = async (descriptor, choice, onProgress, signal) => {
  // Demuxed HLS carries only playlist URLs at classify time; dispatch emits
  // an av-merge plan only once both tracks hold concrete segment URLs.
  const prepared = await materializeDemuxedHls(descriptor, choice, onProgress, signal);
  const plan = dispatch(prepared, choice);

  if (plan.kind === "refuse") {
    throw dispatchRefusalToError(plan.reason, prepared);
  }

  switch (plan.kind) {
    case "direct":
      return runDirectJob(plan, onProgress, signal);

    case "hls-plain":
      return runHlsJob(plan, prepared, onProgress, signal);

    case "av-merge":
      return runAvMergeJob(plan, onProgress, signal);
  }
};

export type { DownloadJob, JobResult, ProgressFn };
export type { StreamDescriptor, UserChoice } from "@savemedia/core";
