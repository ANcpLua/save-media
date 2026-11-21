import { dispatch } from "@savemedia/core";
import type { DownloadJob, JobResult, ProgressFn } from "./job";
import { runDirectJob } from "./jobs/direct";
import { runHlsJob } from "./jobs/hls";
import { runAvMergeJob } from "./jobs/av-merge";
import { materializeDemuxedHls } from "./parsers/hls";
import { dispatchRefusalToError } from "../util/dispatch-refusal";

import { withDesktopRecovery } from "../native/file-connection";
import { fetchWithRetry } from "./net/fetch-with-retry";

declare const __BROWSER__: "chromium" | "firefox";

export const downloadJob: DownloadJob = async (descriptor, choice, onProgress, signal) => {
  // Demuxed HLS carries only playlist URLs at classify time; dispatch emits
  // an av-merge plan only once both tracks hold concrete segment URLs.
  const local = !descriptor.drm && typeof __BROWSER__ !== "undefined" && __BROWSER__ === "chromium"
    && await chrome.runtime.sendMessage({ type: "desktop-connection-enabled" }).catch(() => false);
  const fetchFile = local === true ? withDesktopRecovery(fetch, descriptor.pageUrl) : fetch;
  const request: typeof fetchWithRetry = (url, signal, cls, init) => fetchWithRetry(url, signal, cls, init, fetchFile);
  const prepared = await materializeDemuxedHls(descriptor, choice, onProgress, signal, request);
  const plan = dispatch(prepared, choice);

  if (plan.kind === "refuse") {
    throw dispatchRefusalToError(plan.reason, prepared);
  }

  switch (plan.kind) {
    case "direct":
      return runDirectJob(plan, onProgress, signal, descriptor.tabId, fetchFile);

    case "hls-plain":
      return runHlsJob(plan, prepared, onProgress, signal, undefined, request);

    case "av-merge":
      return runAvMergeJob(plan, onProgress, signal, undefined, request);
  }
};

export type { DownloadJob, JobResult, ProgressFn };
export type { StreamDescriptor, UserChoice } from "@savemedia/core";
