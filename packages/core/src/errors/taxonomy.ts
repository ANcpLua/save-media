import type { DrmSignalSource, OutputContainer, Container } from "../types/stream";
import type { VideoCodec, AudioCodec } from "../types/codec";

export type JobErrorSeverity = "terminal" | "recoverable";

export type JobError =
  // DRM / CDM-bound encryption
  | { code: "encrypted_media_detected";   severity: "terminal";    detectedVia: readonly DrmSignalSource[]; keySystem: string | null }
  | { code: "cdm_required";               severity: "terminal";    keySystem: string }
  | { code: "clear_segments_unavailable"; severity: "terminal";    manifestUrl: string }
  | { code: "license_bound_stream";       severity: "terminal";    keyUri: string; httpStatus: number }
  | { code: "clearkey_deferred";          severity: "terminal";    manifestUrl: string }

  // Source availability
  | { code: "live_window_expired";        severity: "terminal";    missingSegmentsFromStart: number; manifestRefreshAt: number }
  | { code: "manifest_404";               severity: "terminal";    url: string; httpStatus: number }
  | { code: "manifest_malformed";         severity: "terminal";    url: string; parserError: string }

  // Track availability
  | { code: "missing_video_track";        severity: "terminal";    declaredIn: "manifest" | "init-segment" }
  | { code: "missing_audio_track";        severity: "terminal";    requiredFor: "Best Quality" | "MP4 Compatible"; declaredIn: "manifest" | "init-segment" }
  | { code: "no_variant_meets_minimum";   severity: "terminal";    minHeightRequired: 720; maxAvailableHeight: number }

  // Codec compatibility
  | { code: "unsupported_codec";          severity: "terminal";    codec: VideoCodec | AudioCodec; where: "source" | "target" }
  | { code: "no_remux_path";              severity: "terminal";    from: Container; to: OutputContainer; reason: "container-not-supported-by-mediabunny" | "codec-incompatible-with-target" }
  | { code: "no_transcode_path";          severity: "terminal";    from: Container; to: OutputContainer; reason: string }

  // Network
  | { code: "segment_fetch_failed";       severity: "recoverable"; segmentIndex: number; url: string; httpStatus: number | "network-error"; attemptsRemaining: number }
  | { code: "segment_budget_exhausted";   severity: "terminal";    failedSegments: readonly number[]; totalSegments: number }
  | { code: "manifest_refresh_failed";    severity: "recoverable"; url: string; httpStatus: number | "network-error"; attemptsRemaining: number }

  // Browser security
  | { code: "cors_blocked";               severity: "terminal";    url: string; blockedHeader: "Access-Control-Allow-Origin" | "Access-Control-Allow-Headers" | "credentials" }
  | { code: "mixed_content_blocked";      severity: "terminal";    pageProtocol: "https"; resourceProtocol: "http"; url: string }

  // Verification
  | { code: "verification_segment_count"; severity: "terminal";    expected: number; got: number }
  | { code: "verification_duration";      severity: "terminal";    expectedMs: number; gotMs: number; toleranceMs: number }
  | { code: "verification_checksum";      severity: "terminal";    algo: "sha256"; expected: string; got: string }
  | { code: "verification_container";     severity: "terminal";    probeError: string }

  // Engine
  | { code: "mediabunny_demux_failed";    severity: "terminal";    at: "header" | "segment" | "trailer"; detail: string }
  | { code: "ffmpeg_wasm_load_failed";    severity: "recoverable"; bytesDownloaded: number; totalBytes: number; attemptsRemaining: number }
  | { code: "ffmpeg_transcode_failed";    severity: "terminal";    ffmpegStderrTail: string }
  | { code: "engine_oom";                 severity: "terminal";    workerMemoryMb: number; budgetMb: 64 }

  // Native host
  | { code: "native_host_not_registered"; severity: "terminal";    hint: string }
  | { code: "native_host_dependency";     severity: "terminal";    missing: "python" | "yt-dlp" | "ffmpeg"; installHint: string }
  | { code: "native_host_timeout";        severity: "recoverable"; timeoutSeconds: number; phase: string; attemptsRemaining: number }
  | { code: "native_host_protocol";       severity: "terminal";    detail: string }
  | { code: "native_sink_io_error";       severity: "terminal";    errno: string; path: string }

  // Cancellation
  | { code: "user_cancelled";             severity: "terminal";    bytesDiscarded: number };

export type JobErrorCode = JobError["code"];

export function isTerminal(err: JobError): boolean {
  return err.severity === "terminal";
}

export function isRecoverable(err: JobError): boolean {
  return err.severity === "recoverable";
}
