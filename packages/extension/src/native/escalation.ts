import type { StreamDescriptor, UserChoice, JobError } from "@savemedia/core";
import type { JobResult, ProgressFn } from "../engine/job";
import { createNativeBridge, NativeHostNotAvailableError, NativeHostProtocolError, type ConnectNative } from "./bridge";
import { escalateToYtdlp } from "./ytdlp";
import { streamToNativeSink } from "./sink";

/**
 * Native-side fallbacks the engine reaches for when the in-browser path
 * can't satisfy the job: cookie-bound CDNs (yt-dlp) and >2 GB sinks.
 *
 * All entry points share a single bridge instance that auto-disconnects
 * after the job completes / aborts so we don't leak native-host processes.
 */

export async function runYtdlpEscalation(
  descriptor: StreamDescriptor,
  choice: UserChoice,
  outputDir: string,
  connect?: ConnectNative,
): Promise<JobResult> {
  const bridge = createNativeBridge(connect);
  try {
    const result = await escalateToYtdlp(bridge, {
      url: descriptor.source.kind === "direct-url"
        ? descriptor.source.url
        : descriptor.pageUrl,
      quality: qualityHint(choice),
      outputDir,
    });
    return {
      blobUrl: `file://${result.outputPath}`,
      filename: choice.filename,
      checksum: result.checksum,
    };
  } catch (err) {
    throw toJobError(err);
  } finally {
    bridge.disconnect();
  }
}

export async function streamLargeOutputToNative(
  filename: string,
  source: Blob,
  signal: AbortSignal,
  onProgress: ProgressFn,
  connect?: ConnectNative,
): Promise<JobResult> {
  const bridge = createNativeBridge(connect);
  try {
    const result = await streamToNativeSink(bridge, filename, source, signal, (w, t) =>
      onProgress(w, t, "streaming-to-native"),
    );
    return {
      blobUrl: `file://${result.outputPath}`,
      filename,
      checksum: result.checksum,
    };
  } catch (err) {
    throw toJobError(err);
  } finally {
    bridge.disconnect();
  }
}

function qualityHint(choice: UserChoice): "best" | "1080p" | "720p" {
  if (choice.outputMode === "Small File") return "720p";
  if (choice.outputMode === "MP4 Compatible") return "1080p";
  return "best";
}

function toJobError(err: unknown): JobError {
  if (err instanceof NativeHostNotAvailableError) {
    return {
      code: "native_host_not_registered",
      severity: "terminal",
      hint: err.detail,
    };
  }
  if (err instanceof NativeHostProtocolError) {
    return {
      code: "native_host_protocol",
      severity: "terminal",
      detail: err.detail,
    };
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return { code: "user_cancelled", severity: "terminal", bytesDiscarded: 0 };
  }
  return {
    code: "native_host_protocol",
    severity: "terminal",
    detail: err instanceof Error ? err.message : String(err),
  };
}
