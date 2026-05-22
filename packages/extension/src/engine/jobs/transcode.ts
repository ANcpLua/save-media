import type { RemuxPlan, TranscodePlan } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../job";
import { loadFFmpeg, type FFmpegLoaderDeps } from "../transcode/ffmpeg-loader";

export interface TranscodeJobInput {
  /** Source bytes already concatenated in memory (e.g. from a prior HLS/DASH job). */
  readonly sourceBytes: Uint8Array;
  readonly sourceFilename: string;
}

/**
 * Run ffmpeg.wasm remux or transcode against in-memory bytes.
 *
 * For MP4 Compatible / Small File presets we use a stable -c:v h264 -c:a aac
 * command. For a pure container change (remux) we use -c copy. Both write to
 * an MP4 container.
 *
 * Lazy-loads the bundled core via loadFFmpeg(); surfaces
 * ffmpeg_wasm_load_failed on first attempt or no_transcode_path when the
 * command itself fails.
 */
export async function runTranscodeJob(
  plan: TranscodePlan | RemuxPlan,
  input: TranscodeJobInput,
  onProgress: ProgressFn,
  signal: AbortSignal,
  deps: FFmpegLoaderDeps,
): Promise<JobResult> {
  if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");

  onProgress(0, null, "loading-ffmpeg");
  const load = await loadFFmpeg(deps);
  if (!load.ok) {
    throw {
      code: "ffmpeg_wasm_load_failed",
      severity: "recoverable",
      bytesDownloaded: load.bytesDownloaded,
      totalBytes: load.totalBytes,
      attemptsRemaining: load.attemptsRemaining,
    };
  }

  const ffmpeg = load.instance;
  const inName = sanitizeFsName(input.sourceFilename);
  const outName = `out.${plan.outputContainer}`;

  onProgress(0, input.sourceBytes.byteLength, "writing-input");
  await ffmpeg.writeFile(inName, input.sourceBytes);

  ffmpeg.on("progress", (e: unknown) => {
    const ratio = readProgressRatio(e);
    if (ratio !== null) onProgress(Math.round(input.sourceBytes.byteLength * ratio), input.sourceBytes.byteLength, "transcoding");
  });

  const args = plan.kind === "remux"
    ? ["-i", inName, "-c", "copy", outName]
    : ["-i", inName, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", outName];

  let rc: number;
  try {
    rc = await ffmpeg.exec(args);
  } catch (err) {
    throw {
      code: plan.kind === "transcode" ? "ffmpeg_transcode_failed" : "no_remux_path",
      severity: "terminal",
      ...(plan.kind === "transcode"
        ? { ffmpegStderrTail: err instanceof Error ? err.message.slice(-512) : String(err).slice(-512) }
        : { from: plan.fromContainer, to: plan.outputContainer, reason: "container-not-supported-by-mediabunny" }),
    };
  }
  if (rc !== 0) {
    throw plan.kind === "transcode"
      ? { code: "ffmpeg_transcode_failed", severity: "terminal", ffmpegStderrTail: `exit ${rc}` }
      : { code: "no_remux_path", severity: "terminal", from: plan.fromContainer, to: plan.outputContainer, reason: "codec-incompatible-with-target" };
  }

  const out = await ffmpeg.readFile(outName);
  const outBytes = typeof out === "string" ? new TextEncoder().encode(out) : out;
  const blob = new Blob([outBytes as BlobPart], { type: mimeForContainer(plan.outputContainer) });
  onProgress(outBytes.byteLength, outBytes.byteLength, "finalizing");
  return {
    blobUrl: URL.createObjectURL(blob),
    filename: plan.outputFilename,
    checksum: "",
  };
}

function mimeForContainer(c: string): string {
  switch (c) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mkv": return "video/x-matroska";
    default: return "application/octet-stream";
  }
}

function sanitizeFsName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "input";
}

function readProgressRatio(e: unknown): number | null {
  if (e && typeof e === "object" && "progress" in e) {
    const value = (e as { progress: unknown }).progress;
    if (typeof value === "number" && value >= 0 && value <= 1) return value;
  }
  return null;
}
