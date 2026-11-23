import type { BrowserRequestDiagnostic, JobError, JobErrorCode } from "../../src/errors/taxonomy";

export const PRIVATE = "https://media.example/private/path/clip.mp4?token=secret";

export function diagnostic(fields: Partial<BrowserRequestDiagnostic> = {}): BrowserRequestDiagnostic {
  return { host: "cdn.example", code: null, ip: null, finalHost: null, redirect: null, ...fields };
}

/** The variants of every code. The record type fails to compile when a code has none. */
export const VARIANTS: { readonly [C in JobErrorCode]: readonly Extract<JobError, { code: C }>[] } = {
  encrypted_media_detected: [
    { code: "encrypted_media_detected", severity: "terminal", detectedVia: ["eme-hook", "mp4-protection"], keySystem: "com.widevine.alpha" },
    { code: "encrypted_media_detected", severity: "terminal", detectedVia: ["mpeg-ts"], keySystem: null },
    { code: "encrypted_media_detected", severity: "terminal", detectedVia: ["matroska-protection"], keySystem: null },
  ],
  cdm_required: [
    { code: "cdm_required", severity: "terminal", keySystem: "com.widevine.alpha", detectedVia: ["dash-content-protection"] },
    { code: "cdm_required", severity: "terminal", keySystem: "SAMPLE-AES", detectedVia: ["hls-ext-x-key"] },
    { code: "cdm_required", severity: "terminal", keySystem: "com.apple.streamingkeydelivery" },
    { code: "cdm_required", severity: "terminal", keySystem: "unknown", detectedVia: ["eme-hook"] },
  ],
  license_bound_stream: [{ code: "license_bound_stream", severity: "terminal", keyUri: PRIVATE, httpStatus: 403 }],
  clearkey_deferred: [
    { code: "clearkey_deferred", severity: "terminal", manifestUrl: PRIVATE },
    { code: "clearkey_deferred", severity: "terminal", manifestUrl: PRIVATE, detectedVia: ["dash-content-protection", "clearkey-detector"] },
  ],
  hls_key_unusable: [
    { code: "hls_key_unusable", severity: "terminal", keyUri: PRIVATE, response: "page", byteLength: 512 },
    { code: "hls_key_unusable", severity: "terminal", keyUri: PRIVATE, response: "data", byteLength: 40 },
    { code: "hls_key_unusable", severity: "terminal", keyUri: PRIVATE, response: "binary", byteLength: 240 },
    { code: "hls_key_unusable", severity: "terminal", keyUri: PRIVATE, response: "rejected", byteLength: 16 },
  ],
  manifest_malformed: [{ code: "manifest_malformed", severity: "terminal", url: PRIVATE, parserError: `line 3: bad tag at ${PRIVATE}` }],
  manifest_too_large: [
    { code: "manifest_too_large", severity: "terminal", url: PRIVATE, limit: "segments" },
    { code: "manifest_too_large", severity: "terminal", url: PRIVATE, limit: "bytes" },
  ],
  private_network_target: [
    { code: "private_network_target", severity: "terminal", host: "router.local" },
    { code: "private_network_target", severity: "terminal", host: "media.public-site.net", ip: "192.168.1.1" },
  ],
  unsupported_output: [{ code: "unsupported_output", severity: "terminal", from: "webm", to: "mp4", reason: "container-not-supported" }],
  codec_unsupported: [
    { code: "codec_unsupported", severity: "terminal", manifestUrl: PRIVATE, track: "audio", codec: "alac" },
    { code: "codec_unsupported", severity: "terminal", manifestUrl: PRIVATE, track: "video", codec: "prores" },
  ],
  dash_unsupported: [{ code: "dash_unsupported", severity: "terminal", manifestUrl: PRIVATE }],
  hls_encryption_unsupported: [{ code: "hls_encryption_unsupported", severity: "terminal", manifestUrl: PRIVATE, method: "AES-128" }],
  hls_live_unsupported: [{ code: "hls_live_unsupported", severity: "terminal", manifestUrl: PRIVATE }],
  hls_layout_unsupported: [
    { code: "hls_layout_unsupported", severity: "terminal", manifestUrl: PRIVATE, layout: "init-boxes" },
    { code: "hls_layout_unsupported", severity: "terminal", manifestUrl: PRIVATE, layout: "not-transport-stream" },
    { code: "hls_layout_unsupported", severity: "terminal", manifestUrl: PRIVATE, layout: "init-changes" },
  ],
  range_body_empty: [{ code: "range_body_empty", severity: "terminal", host: "cdn.example", rangeStart: 10, rangeEnd: 20, totalBytes: 30,
    declaredBytes: null, reconnects: 2, reason: "stream-ended" }],
  transfer_failed: (["ended-early", "resume-refused", "resume-unverifiable", "file-changed", "content-mismatch", "range-mismatch",
    "range-length", "range-slices", "range-encoded", "body-long", "link-changed"] as const).map(reason =>
    ({ code: "transfer_failed", severity: "terminal", reason, host: "cdn.example", receivedBytes: 420 * 1024 ** 2, totalBytes: 512 * 1024 ** 2, httpStatus: 206 } as const)),
  segment_budget_exhausted: [{ code: "segment_budget_exhausted", severity: "terminal", failedSegments: [1, 2], totalSegments: 9 }],
  rate_limited: [
    { code: "rate_limited", severity: "terminal", phase: "direct", url: PRIVATE, httpStatus: 429, retryAfterSeconds: 10 },
    { code: "rate_limited", severity: "terminal", phase: "direct", url: PRIVATE, httpStatus: 429, retryAfterSeconds: 300 },
    { code: "rate_limited", severity: "terminal", phase: "manifest", url: PRIVATE, httpStatus: 429, retryAfterSeconds: null },
  ],
  server_busy: [
    { code: "server_busy", severity: "terminal", phase: "segment", url: PRIVATE, httpStatus: 503 },
    { code: "server_busy", severity: "terminal", phase: "manifest", url: PRIVATE, httpStatus: 522 },
  ],
  http_error: [
    { code: "http_error", severity: "terminal", phase: "manifest", url: PRIVATE, httpStatus: 500 },
    { code: "http_error", severity: "terminal", phase: "direct", url: PRIVATE, httpStatus: 404 },
    { code: "http_error", severity: "terminal", phase: "manifest", url: PRIVATE, httpStatus: 404, atSaveStart: true },
  ],
  access_denied: [
    { code: "access_denied", severity: "terminal", phase: "direct", url: PRIVATE, httpStatus: 403, explanation: "forbidden-or-expired-url" },
    { code: "access_denied", severity: "terminal", phase: "direct", url: PRIVATE, httpStatus: 401, explanation: "login-or-cookie" },
    { code: "access_denied", severity: "terminal", phase: "direct", url: PRIVATE, httpStatus: 402, explanation: "payment-or-entitlement" },
    { code: "access_denied", severity: "terminal", phase: "direct", url: PRIVATE, httpStatus: 451, explanation: "legal-restriction" },
    { code: "access_denied", severity: "terminal", phase: "manifest", url: PRIVATE, httpStatus: 403, explanation: "forbidden-or-expired-url", atSaveStart: true },
  ],
  network_unreachable: [
    { code: "network_unreachable", severity: "terminal", phase: "direct", url: PRIVATE, during: "request" },
    { code: "network_unreachable", severity: "terminal", phase: "direct", url: PRIVATE, during: "transfer", receivedBytes: 300 * 1024 ** 2, totalBytes: 512 * 1024 ** 2 },
    { code: "network_unreachable", severity: "terminal", phase: "segment", url: PRIVATE, during: "timeout", receivedBytes: 140 * 1024, totalBytes: null },
    { code: "network_unreachable", severity: "terminal", phase: "direct", url: PRIVATE, during: "request",
      browserDiagnostic: diagnostic({ code: "net::ERR_CONNECTION_RESET", ip: "203.0.113.9" }) },
  ],
  tls_certificate_rejected: [{ code: "tls_certificate_rejected", severity: "terminal", phase: "direct",
    browserDiagnostic: diagnostic({ code: "net::ERR_CERT_AUTHORITY_INVALID", host: "cdn.example:8443" }) }],
  insecure_media_redirect: [{ code: "insecure_media_redirect", severity: "terminal" }],
  verification_segment_count: [{ code: "verification_segment_count", severity: "terminal", expected: 4, got: 3 }],
  verification_duration: [{ code: "verification_duration", severity: "terminal", expectedMs: 1000, gotMs: 900, toleranceMs: 50 }],
  verification_checksum: [{ code: "verification_checksum", severity: "terminal", algo: "sha256", expected: "aa/bb", got: "cc dd" }],
  verification_container: [{ code: "verification_container", severity: "terminal", probeError: "no moov box in /tmp/file" }],
  engine_job_failed: [
    { code: "engine_job_failed", severity: "terminal", at: "segment", detail: `hls/mpegts: boom at ${PRIVATE}`, cause: "unexpected" },
    { code: "engine_job_failed", severity: "terminal", at: "direct", detail: "", cause: "browser-resume" },
  ],
  engine_stopped: [
    { code: "engine_stopped", severity: "terminal", when: "start" },
    { code: "engine_stopped", severity: "terminal", when: "running" },
    { code: "engine_stopped", severity: "terminal", when: "restart" },
  ],
  unexpected_media_response: [
    { code: "unexpected_media_response", severity: "terminal", response: "page", host: "cdn.example" },
    { code: "unexpected_media_response", severity: "terminal", response: "data" },
    { code: "unexpected_media_response", severity: "terminal", response: "unsupported" },
    { code: "unexpected_media_response", severity: "terminal", response: "page", host: "media.example", atSaveStart: true },
    { code: "unexpected_media_response", severity: "terminal", response: "data", host: "media.example", atSaveStart: true },
  ],
  browser_download_failed: [{ code: "browser_download_failed", severity: "terminal", reason: "FILE_NO_SPACE on /Users/someone", filename: "My private clip.mp4" }],
  user_cancelled: [{ code: "user_cancelled", severity: "terminal" }],
};

export const ALL_VARIANTS: readonly JobError[] = Object.values(VARIANTS).flat();
