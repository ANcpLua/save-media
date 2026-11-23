import type { DrmSignalSource, OutputContainer, Container } from "../types/stream";

/** Every reported error ends its job. The field stays so stored and exported records keep their shape. */
export type JobErrorSeverity = "terminal";

/**
 * What the browser reported about one request savemedia made itself. It is
 * read from the browser's request events only; nothing here is asked of the
 * network. It explains a failure and never changes a request or a retry.
 */
export interface BrowserRequestDiagnostic {
  /** Host (with a port that is not the default) of the address savemedia requested. */
  readonly host: string;
  /** The browser's error code for the request; null when a server answered. */
  readonly code: string | null;
  /** The address of the server that answered or was tried last. */
  readonly ip: string | null;
  /** The host that answered last, when a redirect led away from `host`. */
  readonly finalHost: string | null;
  /** The first redirect to another host. */
  readonly redirect: { readonly toHost: string; readonly status: number; readonly fromIp: string | null } | null;
}

export type JobError =
  // DRM / CDM-bound encryption
  | { code: "encrypted_media_detected";   severity: "terminal";    detectedVia: readonly DrmSignalSource[]; keySystem: string | null }
  /** `detectedVia` is where the protection was declared, when the refusal comes from a listed stream. */
  | { code: "cdm_required";               severity: "terminal";    keySystem: string; detectedVia?: readonly DrmSignalSource[] }
  | { code: "license_bound_stream";       severity: "terminal";    keyUri: string; httpStatus: number }
  | { code: "clearkey_deferred";          severity: "terminal";    manifestUrl: string; detectedVia?: readonly DrmSignalSource[] }
  /**
   * A clear AES-128 key URI answered, but its answer cannot decrypt the stream: a page, a data document, bytes
   * that are not a 16-byte key (binary), or a 16-byte key the segments do not decrypt with (rejected).
   * Never handed to another downloader.
   */
  | { code: "hls_key_unusable";           severity: "terminal";    keyUri: string; response: "page" | "data" | "binary" | "rejected"; byteLength: number;
      browserDiagnostic?: BrowserRequestDiagnostic }

  // Source availability
  | { code: "manifest_malformed";         severity: "terminal";    url: string; parserError: string }
  /** The playlist or manifest is larger, or declares more segments, than is read. */
  | { code: "manifest_too_large";         severity: "terminal";    url: string; limit: "bytes" | "segments" }
  /**
   * A page on the public internet points at a server inside the user's network, and the browser itself was
   * not answered from that server for this page. Without `ip` the address itself names that server and
   * nothing was requested. With `ip`, a public name led there: the browser reported that address for the one
   * request made, and its answer was not used.
   */
  | { code: "private_network_target";     severity: "terminal";    host: string; ip?: string }

  // Output
  | { code: "unsupported_output";         severity: "terminal";    from: Container; to: OutputContainer; reason: "conversion-not-implemented" | "container-not-supported" }
  /** A track declares a codec the MP4 file savemedia writes cannot hold. `codec` is the codec's family, a closed set. */
  | { code: "codec_unsupported";          severity: "terminal";    manifestUrl: string; track: "video" | "audio"; codec: string }
  | { code: "dash_unsupported";           severity: "terminal";    manifestUrl: string }
  | { code: "hls_encryption_unsupported"; severity: "terminal";    manifestUrl: string; method: string }
  | { code: "hls_live_unsupported";       severity: "terminal";    manifestUrl: string }
  /**
   * not-transport-stream: a segment is not MPEG-TS; init-boxes / fragment-boxes: required fMP4 boxes are missing;
   * box-structure: an fMP4 box is cut or mis-sized; byte-ranges: the parts are byte ranges that do not add up to
   * one whole file, or are encrypted range by range; init-changes: a fragmented MP4 playlist names another
   * header (EXT-X-MAP) part-way, so its parts are not one MP4.
   */
  | { code: "hls_layout_unsupported";     severity: "terminal";    manifestUrl: string;
      layout: "not-transport-stream" | "init-boxes" | "fragment-boxes" | "box-structure" | "byte-ranges" | "init-changes" }

  // Network
  | { code: "range_body_empty"; severity: "terminal"; host: string; rangeStart: number; rangeEnd: number; totalBytes: number;
      declaredBytes: number | null; reconnects: number; reason: "declared-empty" | "stream-ended" | "read-error" | "timeout" }
  /** A direct file transfer stopped for a reason in TransferFailureReason; the text is written by userMessage. */
  | { code: "transfer_failed"; severity: "terminal"; reason: TransferFailureReason; host: string;
      receivedBytes: number | null; totalBytes: number | null; httpStatus: number | null; browserDiagnostic?: BrowserRequestDiagnostic }
  | { code: "segment_budget_exhausted";   severity: "terminal";    failedSegments: readonly number[]; totalSegments: number }
  | { code: "rate_limited";               severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string; httpStatus: 429; retryAfterSeconds: number | null }
  | { code: "server_busy";                severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string; httpStatus: number;
      browserDiagnostic?: BrowserRequestDiagnostic }
  /**
   * `atSaveStart` (on this and on access_denied): the request was for the video's playlist or manifest, read
   * again as the save started. The video was listed from an answer the same playlist gave before.
   */
  | { code: "http_error";                 severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string; httpStatus: number;
      atSaveStart?: true; browserDiagnostic?: BrowserRequestDiagnostic }
  | { code: "access_denied";              severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string; httpStatus: 401 | 402 | 403 | 451;
      explanation: "login-or-cookie" | "payment-or-entitlement" | "forbidden-or-expired-url" | "legal-restriction"; atSaveStart?: true;
      browserDiagnostic?: BrowserRequestDiagnostic }
  | { code: "network_unreachable";        severity: "terminal";    phase: "manifest" | "segment" | "direct"; url: string;
      /** request: no response arrived; transfer: the connection dropped during the body; timeout: data stopped arriving. */
      during: "request" | "transfer" | "timeout"; receivedBytes?: number; totalBytes?: number | null; browserDiagnostic?: BrowserRequestDiagnostic }

  // Browser security
  | { code: "tls_certificate_rejected"; severity: "terminal"; phase: "manifest" | "segment" | "direct"; browserDiagnostic: BrowserRequestDiagnostic }
  | { code: "insecure_media_redirect"; severity: "terminal" }

  // Verification
  | { code: "verification_segment_count"; severity: "terminal";    expected: number; got: number }
  | { code: "verification_duration";      severity: "terminal";    expectedMs: number; gotMs: number; toleranceMs: number }
  | { code: "verification_checksum";      severity: "terminal";    algo: "sha256"; expected: string; got: string }
  | { code: "verification_container";     severity: "terminal";    probeError: string }

  // Engine
  /**
   * `cause` names what stopped the job in closed words: browser-resume is Chrome's own resume of its
   * interrupted download; anything else is unexpected. `detail` is a technical note, never main text.
   */
  | { code: "engine_job_failed";          severity: "terminal";    at: "manifest" | "init" | "segment" | "direct" | "finalize"; detail: string;
      cause?: "unexpected" | "browser-resume" }
  /**
   * The browser ended the process that was saving the file. start: it never opened; running: it closed
   * during the save; restart: the browser paused the extension and the save did not survive it.
   */
  | { code: "engine_stopped";             severity: "terminal";    when: "start" | "running" | "restart" }
  /**
   * The answer is a web page, a data document, or bytes of no supported video format. `host` is the server asked.
   * `atSaveStart`: the request was for the video's playlist or manifest, read again as the save started. It was a
   * playlist when the video was found, and the same address now sends something that is none.
   */
  | { code: "unexpected_media_response"; severity: "terminal"; response: "page" | "data" | "unsupported"; host?: string;
      atSaveStart?: true; browserDiagnostic?: BrowserRequestDiagnostic }
  | { code: "browser_download_failed";    severity: "terminal";    reason: string; filename: string }

  // Cancellation
  /** The user stopped the save. Shown as a neutral state, never as a failure. */
  | { code: "user_cancelled";             severity: "terminal" };

/**
 * Why a direct file transfer stopped, when the server answered but its
 * answer cannot become a verified file:
 * ended-early: the body ended before its announced length and could not continue;
 * resume-refused: the server would not send the rest (HTTP 200, 400, 416 or 501 to a Range request);
 * resume-unverifiable: no ETag, Last-Modified date or checksum proves the rest belongs to the same file;
 * file-changed / content-mismatch: the file on the server is no longer the one partly saved;
 * range-mismatch / range-length / range-slices / range-encoded / body-long: byte ranges that do not fit together;
 * link-changed: the link now leads to another resource.
 */
export type TransferFailureReason =
  | "ended-early" | "resume-refused" | "resume-unverifiable" | "file-changed" | "content-mismatch"
  | "range-mismatch" | "range-length" | "range-slices" | "range-encoded" | "body-long" | "link-changed";

export type JobErrorCode = JobError["code"];

/** The one structural test for a JobError thrown or passed around as a plain object. */
export function isJobError(value: unknown): value is JobError {
  return !!value && typeof value === "object" && "code" in value && "severity" in value;
}
