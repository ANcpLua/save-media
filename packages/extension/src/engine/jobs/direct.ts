import type { DirectPlan } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";

/**
 * Direct downloads bypass the engine entirely — the background worker calls
 * chrome.downloads.download with the source URL. This branch shouldn't
 * normally execute in the engine, but if the dispatcher ever routes a direct
 * plan here we still produce a valid result by streaming the bytes to a
 * Blob URL so the caller can finalize.
 */
export async function runDirectJob(
  plan: DirectPlan,
  onProgress: ProgressFn,
  signal: AbortSignal,
): Promise<JobResult> {
  onProgress(0, null, "downloading");
  const response = await fetch(plan.url, { signal });
  if (!response.ok) {
    throw {
      code: "manifest_404",
      severity: "terminal",
      url: plan.url,
      httpStatus: response.status,
    };
  }
  const blob = await response.blob();
  onProgress(blob.size, blob.size, "finalizing");
  return {
    blobUrl: URL.createObjectURL(blob),
    filename: plan.filename,
    checksum: "",
  };
}
