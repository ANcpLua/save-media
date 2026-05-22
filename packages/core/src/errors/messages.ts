import type { JobError } from "./taxonomy";

export type ActionKind =
  | "retry-job" | "retry-from-now" | "override-min-quality"
  | "open-settings" | "escalate-to-native" | "open-installer" | "open-docs";

export interface UserMessage {
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly kind: ActionKind } | null;
}

function formatBytes(b: number): string {
  if (b < 1e6) return `${(b / 1e3).toFixed(1)} KB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e9).toFixed(2)} GB`;
}

export function userMessage(err: JobError): UserMessage {
  switch (err.code) {
    case "encrypted_media_detected":
    case "cdm_required":
    case "license_bound_stream":
      return {
        title: "This stream is protected",
        body: "savemedia cannot decrypt or bypass DRM-protected media. The site uses an encrypted media license workflow that browsers handle inside a hardware-isolated decoder; the decrypted frames are never made available to extensions.",
        action: null,
      };

    case "clear_segments_unavailable":
      return {
        title: "Stream is encrypted end-to-end",
        body: "All segments in this stream are encrypted with no accessible decryption key. This is a DRM-protected stream and cannot be saved.",
        action: null,
      };

    case "clearkey_deferred":
      return {
        title: "ClearKey decryption deferred to v2",
        body: "This stream uses ClearKey / CENC sample-encryption. Full decryption support is deferred to v2. The decryption keys are technically accessible, but savemedia v1 does not implement the per-sample AES-CTR decryptor needed to read ClearKey streams.",
        action: null,
      };

    case "live_window_expired":
      return {
        title: "Live segments no longer available",
        body: `The first ${err.missingSegmentsFromStart} segments of this live stream have already aged out of the playback window. Start a new download to capture only the segments still available.`,
        action: { label: "Start new download from current position", kind: "retry-from-now" },
      };

    case "manifest_404":
      return {
        title: "Manifest unavailable",
        body: `The streaming manifest at ${err.url} returned HTTP ${err.httpStatus}. The stream may have been removed or moved.`,
        action: null,
      };

    case "manifest_malformed":
      return {
        title: "Manifest could not be parsed",
        body: `The streaming manifest at ${err.url} is malformed. Parser error: ${err.parserError}`,
        action: null,
      };

    case "missing_video_track":
      return {
        title: "No video track in source",
        body: `The source advertises no video track in its ${err.declaredIn}. savemedia only handles complete video items — audio-only streams are out of scope.`,
        action: null,
      };

    case "missing_audio_track":
      return {
        title: "No audio track in source",
        body: `Output mode ${err.requiredFor} requires an audio track, but none is declared in the ${err.declaredIn}.`,
        action: null,
      };

    case "no_variant_meets_minimum":
      return {
        title: "Source quality is below 720p",
        body: `The highest available quality is ${err.maxAvailableHeight}p. savemedia treats sub-720p sources as below minimum quality. Continue anyway to download at ${err.maxAvailableHeight}p?`,
        action: { label: "Download anyway", kind: "override-min-quality" },
      };

    case "unsupported_codec":
      return {
        title: "Codec not supported in selected output",
        body: `${err.codec.rfc6381 ?? err.codec.family} cannot be ${err.where === "source" ? "decoded" : "produced"} by the current engine. Choose a different output format, or use the native host for transcoding (Settings → Native ffmpeg).`,
        action: { label: "Open Settings", kind: "open-settings" },
      };

    case "no_remux_path":
      return {
        title: "Can't remux to chosen container",
        body: `Cannot remux from ${err.from} to ${err.to}: ${err.reason}. A transcode will be needed.`,
        action: { label: "Open Settings", kind: "open-settings" },
      };

    case "no_transcode_path":
      return {
        title: "Transcoding not possible",
        body: `Cannot transcode from ${err.from} to ${err.to}: ${err.reason}`,
        action: null,
      };

    case "segment_fetch_failed":
      return {
        title: "Segment retry in progress",
        body: `Segment ${err.segmentIndex} failed (HTTP ${err.httpStatus}). ${err.attemptsRemaining} retries remaining.`,
        action: null,
      };

    case "segment_budget_exhausted":
      return {
        title: "Too many segment failures",
        body: `${err.failedSegments.length} of ${err.totalSegments} segments failed after retries. The partial file has been deleted.`,
        action: { label: "Retry full download", kind: "retry-job" },
      };

    case "manifest_refresh_failed":
      return {
        title: "Live manifest refresh failed",
        body: `Could not refresh the live playlist at ${err.url} (HTTP ${err.httpStatus}). ${err.attemptsRemaining} retries remaining.`,
        action: null,
      };

    case "cors_blocked":
      return {
        title: "Browser blocked the request",
        body: `The browser refused to fetch from this origin because the server didn't allow it (missing ${err.blockedHeader}). This is a server-side restriction; savemedia cannot work around it.`,
        action: null,
      };

    case "mixed_content_blocked":
      return {
        title: "Mixed content blocked",
        body: "The page is HTTPS but the media resource is HTTP. Browsers block this. The site needs to serve media over HTTPS.",
        action: null,
      };

    case "verification_segment_count":
    case "verification_duration":
    case "verification_checksum":
    case "verification_container":
      return {
        title: "Download verification failed",
        body: "The downloaded file did not pass integrity checks. It has been deleted so it cannot be mistaken for a complete download.",
        action: { label: "Retry full download", kind: "retry-job" },
      };

    case "mediabunny_demux_failed":
      return {
        title: "Stream couldn't be demuxed",
        body: `The remux engine failed at the ${err.at} stage: ${err.detail}. Try yt-dlp via the native host.`,
        action: { label: "Try with native host", kind: "escalate-to-native" },
      };

    case "ffmpeg_wasm_load_failed":
      return {
        title: "Transcoder couldn't load",
        body: `ffmpeg.wasm core failed to load (${err.bytesDownloaded}/${err.totalBytes} bytes). Retrying.`,
        action: null,
      };

    case "ffmpeg_transcode_failed":
      return {
        title: "Transcode failed",
        body: `ffmpeg returned an error. Last log line: ${err.ffmpegStderrTail}`,
        action: { label: "Try with native host", kind: "escalate-to-native" },
      };

    case "engine_oom":
      return {
        title: "Out of memory",
        body: `The download engine exceeded its ${err.budgetMb} MB budget while processing this stream. Try a lower quality variant, or use the native host fallback (Settings → Use yt-dlp).`,
        action: { label: "Try with native host", kind: "escalate-to-native" },
      };

    case "native_host_not_registered":
      return {
        title: "Native host not installed",
        body: `The optional native host is not registered. ${err.hint} Most streams work without it, but heavy-duty sites need it.`,
        action: { label: "Open installer", kind: "open-installer" },
      };

    case "native_host_dependency":
      return {
        title: `Missing dependency: ${err.missing}`,
        body: `The native host requires ${err.missing}. ${err.installHint}`,
        action: { label: "Open install instructions", kind: "open-docs" },
      };

    case "native_host_timeout":
      return {
        title: "Native host timed out",
        body: `Phase '${err.phase}' did not respond within ${err.timeoutSeconds}s. ${err.attemptsRemaining} retries remaining.`,
        action: null,
      };

    case "native_host_protocol":
      return {
        title: "Native host protocol error",
        body: `The native host sent an invalid message: ${err.detail}`,
        action: null,
      };

    case "native_sink_io_error":
      return {
        title: "Disk write failed",
        body: `Writing to ${err.path} failed: ${err.errno}. Check disk space and permissions.`,
        action: null,
      };

    case "user_cancelled":
      return {
        title: "Cancelled",
        body: `Download cancelled by user. ${formatBytes(err.bytesDiscarded)} discarded.`,
        action: null,
      };
  }
}
