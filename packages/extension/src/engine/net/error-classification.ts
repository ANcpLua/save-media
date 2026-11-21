import type { BrowserRequestDiagnostic, JobError } from "@savemedia/core";
import type { RetryableHttpError } from "./fetch-with-retry";

export class BrowserFetchError extends TypeError {
  constructor(readonly diagnostic: BrowserRequestDiagnostic) {
    super("The browser could not complete the media request");
  }
}

export type NetworkPhase = "manifest" | "segment" | "direct";

export function classifyNetworkFailure(
  err: unknown,
  phase: NetworkPhase,
  fallbackUrl: string,
): JobError | null {
  if (!isRetryableHttpError(err)) return null;

  const url = err.url || fallbackUrl;
  if (err.status === 429) {
    return {
      code: "rate_limited",
      severity: "terminal",
      phase,
      url,
      httpStatus: 429,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }

  if (err.status === 401 || err.status === 402 || err.status === 403 || err.status === 451) {
    return {
      code: "access_denied",
      severity: "terminal",
      phase,
      url,
      httpStatus: err.status,
      explanation: err.status === 401
        ? "login-or-cookie"
        : err.status === 402
          ? "payment-or-entitlement"
          : err.status === 451 ? "legal-restriction" : "forbidden-or-expired-url",
    };
  }

  if (typeof err.status === "number" && [408, 425, 500, 502, 503, 504].includes(err.status)) {
    return {
      code: "server_busy",
      severity: "terminal",
      phase,
      url,
      httpStatus: err.status,
    };
  }

  if (err.status === "network-error") {
    return {
      code: "network_unreachable",
      severity: "terminal",
      phase,
      url,
      detail: err.detail,
    };
  }

  return null;
}

export function isRetryableHttpError(err: unknown): err is RetryableHttpError {
  return !!err
    && typeof err === "object"
    && "url" in err
    && "status" in err
    && "attemptsRemaining" in err;
}
