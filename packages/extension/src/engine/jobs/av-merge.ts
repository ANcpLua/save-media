import type { AvMergePlan, MergeTrack } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";
import { fetchWithRetry } from "../net/fetch-with-retry";
import { classifyNetworkFailure } from "../net/error-classification";
import { InMemorySink, type JobSink } from "../sink";
import { mergeAvToMp4 } from "../remux/merge-av";

/**
 * Engine-side job for demuxed sources: fetch the video track's segments and
 * the audio track's segments, concatenate each into a complete byte stream,
 * and mux both into one MP4 with no re-encode (see {@link mergeAvToMp4}).
 *
 * Concatenating a track's init segment + ordered media `.m4s` yields a
 * demuxable fragmented-fMP4 stream; a progressive track is a single URL with
 * no init. This is verified end-to-end against real fragmented fixtures.
 */
export async function runAvMergeJob(
  plan: AvMergePlan,
  onProgress: ProgressFn,
  signal: AbortSignal,
  externalSink?: JobSink,
): Promise<JobResult> {
  onProgress(0, plan.estimatedBytes, "fetching-video");
  const videoBytes = await fetchTrack(plan.video, signal, bytes =>
    onProgress(bytes, plan.estimatedBytes, "fetching-video"));

  if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");
  onProgress(videoBytes.byteLength, plan.estimatedBytes, "fetching-audio");
  const audioBytes = await fetchTrack(plan.audio, signal, bytes =>
    onProgress(videoBytes.byteLength + bytes, plan.estimatedBytes, "fetching-audio"));

  if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");

  const total = videoBytes.byteLength + audioBytes.byteLength;
  const merged = await mergeAvToMp4(videoBytes, audioBytes, fraction =>
    onProgress(total, total, `merging ${Math.round(fraction * 100)}%`));

  const filename = replaceExt(plan.outputFilename, "mp4");
  const sink = externalSink ?? new InMemorySink("video/mp4");
  await sink.open(filename, total);
  await sink.write(merged);
  onProgress(total, total, "finalizing");
  return sink.close();
}

async function fetchTrack(
  track: MergeTrack,
  signal: AbortSignal,
  onBytes: (bytesSoFar: number) => void,
): Promise<Uint8Array> {
  const urls = track.initUrl ? [track.initUrl, ...track.segmentUrls] : [...track.segmentUrls];
  if (urls.length === 0) {
    throw { code: "manifest_malformed", severity: "terminal", url: "", parserError: "merge track has no segments" };
  }

  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (const url of urls) {
    if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");
    try {
      const resp = await fetchWithRetry(url, signal, "segment");
      const body = new Uint8Array(await resp.arrayBuffer());
      parts.push(body);
      bytes += body.byteLength;
      onBytes(bytes);
    } catch (err) {
      if (signal.aborted) throw err;
      throw classifyNetworkFailure(err, "segment", url) ?? {
        code: "segment_budget_exhausted",
        severity: "terminal",
        failedSegments: [],
        totalSegments: urls.length,
      };
    }
  }
  return concat(parts);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function replaceExt(filename: string, ext: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return `${filename}.${ext}`;
  return `${filename.slice(0, idx)}.${ext}`;
}
