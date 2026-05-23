import type { DashPlan, StreamDescriptor } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";
import { fetchWithRetry } from "../net/fetch-with-retry";
import { classifyNetworkFailure } from "../net/error-classification";
import { parseDashJobInputs, type DashTrack } from "../parsers/dash";
import { InMemorySink, type JobSink } from "../sink";

/**
 * DASH job runner. Fetches the MPD, resolves init+media URLs for the
 * chosen variant, then concatenates init segment + media segments into a
 * Blob. This is intentionally limited to the fMP4 path covered by golden
 * media tests.
 *
 * Audio is currently merged inline only when the same variant carries it.
 * Separate audio renditions are not implemented.
 */
export async function runDashJob(
  plan: DashPlan,
  descriptor: StreamDescriptor,
  onProgress: ProgressFn,
  signal: AbortSignal,
  externalSink?: JobSink,
): Promise<JobResult> {
  if (descriptor.source.kind !== "dash-manifest") {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.pageUrl,
      parserError: "dash plan with non-dash source",
    };
  }

  onProgress(0, null, "fetching-manifest");
  const mpdResp = await fetchWithRetry(descriptor.source.manifestUrl, signal, "manifest").catch(err => {
    throw classifyNetworkFailure(err, "manifest", descriptor.source.kind === "dash-manifest" ? descriptor.source.manifestUrl : descriptor.pageUrl) ?? err;
  });
  const mpdText = await mpdResp.text();
  let inputs;
  try {
    inputs = parseDashJobInputs(
      mpdText,
      descriptor.source.manifestUrl,
      plan.variantId,
      plan.audioRenditionId,
    );
  } catch (err) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.source.manifestUrl,
      parserError: err instanceof Error ? err.message : String(err),
    };
  }
  if (!inputs) {
    throw {
      code: "manifest_malformed",
      severity: "terminal",
      url: descriptor.source.manifestUrl,
      parserError: "no usable video track in MPD",
    };
  }

  return downloadTrack(inputs.video, plan, onProgress, signal, externalSink);
}

async function downloadTrack(
  track: DashTrack,
  plan: DashPlan,
  onProgress: ProgressFn,
  signal: AbortSignal,
  externalSink: JobSink | undefined,
): Promise<JobResult> {
  let bytesWritten = 0;
  const mime = plan.outputContainer === "webm" ? "video/webm" : "video/mp4";
  const sink: JobSink = externalSink ?? new InMemorySink(mime);
  await sink.open(plan.outputFilename, plan.estimatedBytes);

  onProgress(0, null, "fetching-init");
  const initResp = await fetchWithRetry(track.initUrl, signal, "segment").catch(err => {
    throw classifyNetworkFailure(err, "segment", track.initUrl) ?? err;
  });
  const initBytes = new Uint8Array(await initResp.arrayBuffer());
  await assertContainerValid(initBytes, plan.outputContainer);
  await sink.write(initBytes);
  bytesWritten += initBytes.byteLength;

  const failed: number[] = [];
  for (let i = 0; i < track.mediaUrls.length; i++) {
    if (signal.aborted) {
      await sink.abort();
      throw new DOMException("user-cancelled", "AbortError");
    }
    try {
      const resp = await fetchWithRetry(track.mediaUrls[i]!, signal, "segment");
      const body = new Uint8Array(await resp.arrayBuffer());
      await sink.write(body);
      bytesWritten += body.byteLength;
      onProgress(bytesWritten, null, `segment ${i + 1}/${track.mediaUrls.length}`);
    } catch (err) {
      if (signal.aborted) throw err;
      failed.push(i);
      await sink.abort();
      throw classifyNetworkFailure(err, "segment", track.mediaUrls[i]!) ?? {
        code: "segment_budget_exhausted",
        severity: "terminal",
        failedSegments: failed,
        totalSegments: track.mediaUrls.length,
      };
    }
  }

  if (signal.aborted) {
    await sink.abort();
    throw new DOMException("user-cancelled", "AbortError");
  }

  onProgress(bytesWritten, bytesWritten, "muxing");
  const result = await sink.close();
  onProgress(bytesWritten, bytesWritten, "finalizing");
  return result;
}

async function assertContainerValid(
  initBytes: Uint8Array,
  expected: DashPlan["outputContainer"],
): Promise<void> {
  const { verify } = await import("@savemedia/core");
  const result = await verify(
    { path: "memory", bytes: 0, checksum: "", head: initBytes.subarray(0, 32) },
    [{ kind: "container-validity", via: "magic-bytes", expected }],
  );
  if (result.kind === "failure") throw result.error;
}
