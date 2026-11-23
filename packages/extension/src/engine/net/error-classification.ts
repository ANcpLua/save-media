import { isCertificateError, isRetryableStatus, type JobError } from "@savemedia/core";
import { isTransferError, type TransferError } from "./transfer-error";

export { BrowserFetchError } from "./transfer-error";

export type NetworkPhase = "manifest" | "segment" | "direct";

/**
 * The one classifier for an HTTP status or a network failure, whichever job
 * met it: the JobError the user sees, or null for any other failure. `url`
 * is the address the JobError names; callers that must not pass a signed
 * address on give its origin.
 */
export function classifyNetworkFailure(err: unknown, phase: NetworkPhase, url: string): JobError | null {
  return isTransferError(err, "http-status", "network", "timeout") ? networkJobError(err, phase, url) : null;
}

/**
 * The same for a playlist or manifest that is read again as its save starts. The video was listed from an
 * answer of that playlist, so a refusing status now is told as such: it answered before and does not now.
 */
export function classifyPlaylistReread(err: unknown, url: string): JobError | null {
  const error = classifyNetworkFailure(err, "manifest", url);
  return error && (error.code === "http_error" || error.code === "access_denied") ? { ...error, atSaveStart: true } : error;
}

/** The JobError for a transfer failure with reason http-status, network or timeout. */
export function networkJobError(err: TransferError, phase: NetworkPhase, url: string): JobError {
  const { facts } = err;
  if (err.reason !== "http-status") {
    if (facts.diagnostic && isCertificateError(facts.diagnostic.code)) {
      return { code: "tls_certificate_rejected", severity: "terminal", phase, browserDiagnostic: facts.diagnostic };
    }
    return { code: "network_unreachable", severity: "terminal", phase, url,
      during: err.reason === "timeout" ? "timeout" : facts.during === "body" ? "transfer" : "request",
      ...(facts.received ? { receivedBytes: facts.received, totalBytes: facts.expected ?? null } : {}),
      ...(facts.diagnostic ? { browserDiagnostic: facts.diagnostic } : {}) };
  }

  const status = facts.status ?? 0;
  if (status === 429) {
    const retryAfterSeconds = facts.retryAfterMs === undefined ? null : Math.ceil(facts.retryAfterMs / 1000);
    return { code: "rate_limited", severity: "terminal", phase, url, httpStatus: 429, retryAfterSeconds };
  }
  if (status === 401 || status === 402 || status === 403 || status === 451) {
    return {
      code: "access_denied",
      severity: "terminal",
      phase,
      url,
      httpStatus: status,
      explanation: status === 401
        ? "login-or-cookie"
        : status === 402
          ? "payment-or-entitlement"
          : status === 451 ? "legal-restriction" : "forbidden-or-expired-url",
    };
  }
  if (isRetryableStatus("manifest", status)) return { code: "server_busy", severity: "terminal", phase, url, httpStatus: status };
  return { code: "http_error", severity: "terminal", phase, url, httpStatus: status };
}
