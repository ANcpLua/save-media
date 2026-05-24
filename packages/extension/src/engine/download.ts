import { dispatch } from "@savemedia/core";
import type { DownloadJob, JobResult, ProgressFn } from "./job";
import { runDirectJob } from "./jobs/direct";
import { runHlsJob } from "./jobs/hls";
import { dispatchRefusalToError } from "../util/dispatch-refusal";

export const downloadJob: DownloadJob = async (descriptor, choice, onProgress, signal) => {
  const plan = dispatch(descriptor, choice);

  if (plan.kind === "refuse") {
    throw dispatchRefusalToError(plan.reason, descriptor);
  }

  switch (plan.kind) {
    case "direct":
      return runDirectJob(plan, onProgress, signal);

    case "hls-plain":
      return runHlsJob(plan, descriptor, onProgress, signal);
  }
};

export type { DownloadJob, JobResult, ProgressFn };
export type { StreamDescriptor, UserChoice } from "@savemedia/core";
