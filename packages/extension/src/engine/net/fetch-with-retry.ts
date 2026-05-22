import { RETRY_POLICY, computeBackoffMs, isRetryableStatus, type RetryClass } from "@savemedia/core";

export interface RetryableHttpError {
  readonly url: string;
  readonly status: number;
  readonly attemptsRemaining: number;
}

/**
 * fetch wrapper that retries network / 5xx / 429-style failures using the
 * retry-policy table from @savemedia/core. Non-retryable HTTP statuses
 * fast-fail with a RetryableHttpError. Final attempt failures throw the
 * same shape so callers can build a JobError with the right code.
 */
export async function fetchWithRetry(
  url: string,
  signal: AbortSignal,
  cls: RetryClass,
  init: RequestInit = {},
): Promise<Response> {
  const policy = RETRY_POLICY[cls];
  const maxAttempts = "maxAttempts" in policy ? policy.maxAttempts : 1;
  let lastStatus = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw new DOMException("user-cancelled", "AbortError");

    let response: Response | undefined;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // Network error — fall through to the retry/exit branch below.
    }

    if (response) {
      if (response.ok) return response;
      lastStatus = response.status;
      if (!isRetryableStatus(cls, response.status)) {
        throw { url, status: response.status, attemptsRemaining: 0 } satisfies RetryableHttpError;
      }
    }

    const isLast = attempt === maxAttempts - 1;
    if (isLast) break;
    const backoff = computeBackoffMs(cls, attempt + 1, Math.random());
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
