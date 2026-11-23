import { dispatch } from "@savemedia/core";
import type { DownloadJob, JobResult, ProgressFn } from "./job";
import { runDirectJob } from "./jobs/direct";
import { runHlsJob } from "./jobs/hls";
import { runAvMergeJob } from "./jobs/av-merge";
import { materializeDemuxedHls } from "./parsers/hls";
import { materializeDash } from "./parsers/dash";
import { dispatchRefusalToError } from "../util/dispatch-refusal";
import { fetchWithRetry } from "./net/fetch-with-retry";
import { observeFetch } from "../util/http-diagnostics";

export const downloadJob: DownloadJob = async (descriptor, choice, context) => {
  const { onProgress, signal, resumeKey, reportHttp, onRetained, onRetainedReleased, prepareRequests, checkAnswer } = context;
  const report = descriptor.source.kind === "direct-url" ? reportHttp : undefined;
  const observed = report ? observeFetch(fetch, report) : fetch;
  // Every request of the job goes through here: playlists, keys, segments and the ranges of a file.
  const fetchFile = checkAnswer ? answersChecked(observed, checkAnswer) : observed;
  // Demuxed HLS carries only playlist URLs at classify time; dispatch emits
  // an av-merge plan only once both tracks hold concrete segment URLs.
  const request: typeof fetchWithRetry = (url, signal, cls, init) => fetchWithRetry(url, signal, cls, init, fetchFile);
  const playlists = await materializeDemuxedHls(descriptor, choice, onProgress, signal, request, prepareRequests);
  // A listed row never carries a DASH stream's whole segment list: the manifest is read again, as an HLS playlist is.
  const prepared = await materializeDash(playlists, choice, onProgress, signal, request, prepareRequests);
  const plan = dispatch(prepared, choice);

  if (plan.kind === "refuse") {
    throw dispatchRefusalToError(plan.reason, prepared, plan);
  }

  switch (plan.kind) {
    case "direct": {
      // The file's own host and the host its address redirects to: the save holds the page's Referer
      // for both until it ends, so no other page's check can switch it between two ranges.
      const source = prepared.source;
      await prepareRequests?.(source.kind === "direct-url" ? [source.url, ...(source.finalUrl ? [source.finalUrl] : [])] : [plan.url]);
      return runDirectJob(plan, { onProgress, signal, tabId: descriptor.tabId, fetchFile, resumeKey, onRetained, onRetainedReleased });
    }

    case "hls-plain":
      return runHlsJob(plan, prepared, { onProgress, signal, request, prepareRequests });

    case "av-merge":
      return runAvMergeJob(plan, { onProgress, signal, request, prepareRequests });
  }
};

type JobFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A fetch whose answers are looked at before the job sees them. An address the job may request can
 * redirect to one it may not (runner.ts): the body of such an answer is dropped unread and the job fails
 * with the refusal `check` throws.
 */
function answersChecked(transport: JobFetch, check: (answeredFrom: string) => void): JobFetch {
  return async (url, init) => {
    const response = await transport(url, init);
    if (response.url) {
      try {
        check(response.url);
      } catch (refusal) {
        void response.body?.cancel().catch(() => undefined);
        throw refusal;
      }
    }
    return response;
  };
}

export type { DownloadJob, JobResult, ProgressFn };
export type { StreamDescriptor, UserChoice } from "@savemedia/core";
