import { RETRY_POLICY, computeBackoffMs, isRetryableStatus, type RetryClass } from "@savemedia/core";

export interface RetryableHttpError {
  readonly url: string;
  readonly status: number;
  readonly attemptsRemaining: number;
}

/**
 * fetch wrapper that retries network / 5xx / 429-style failures using the
 * retry-policy table from @savemedia/core. Throws a structured object on the
 * final failure so the caller can build a JobError with the right code.
 */
export async function fetchWithRetry(
  url: string,
  signal: AbortSignal,
  cls: RetryClass,
  init: RequestInit = {},
): Promise<Response> {
  const policy = RETRY_POLICY[cls];
  const maxAttempts = "maxAttempts" in policy ? policy.maxAttempts : 1;
  let attempt = 0;
  let lastStatus = 0;
  while (attempt < maxAttempts) {
    if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.ok) return response;
      lastStatus = response.status;
      if (!isRetryableStatus(cls, response.status)) {
        throw { url, status: response.status, attemptsRemaining: 0 } satisfies RetryableHttpError;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt === maxAttempts - 1) {
        if (err && typeof err === "object" && "status" in err) throw err;
        throw {
          url,
          status: lastStatus || 0,
          attemptsRemaining: 0,
        } satisfies RetryableHttpError;
      }
    }
    attempt += 1;
    const backoff = computeBackoffMs(cls, attempt, Math.random());
    await sleep(backoff, signal);
  }
  throw { url, status: lastStatus, attemptsRemaining: 0 } satisfies RetryableHttpError;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("user-cancelled", "AbortError"));
      },
      { once: true },
    );
  });
}
