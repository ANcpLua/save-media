import { MAX_AUTOMATIC_WAIT_MS, RETRY_POLICY, computeBackoffMs, isJobError, isRetryableStatus, retryAfterMs, type RetryClass } from "@savemedia/core";
import { delay } from "./retry-delay";
import { TransferError, transportFailure } from "./transfer-error";

/**
 * fetch wrapper that retries network / 5xx / 429-style failures using the
 * retry-policy table from @savemedia/core. A non-retryable HTTP status fails
 * at once; the last failure is thrown as the same TransferError the direct
 * engine uses (http-status with its Retry-After, or network), so one
 * classifier turns every job's failure into its JobError.
 */
export async function fetchWithRetry(
  url: string,
  signal: AbortSignal,
  cls: RetryClass,
  init: RequestInit = {},
  fetchFile: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const maxAttempts = RETRY_POLICY[cls].maxAttempts;
  let failure = new TransferError("network", { url, during: "request" });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    signal.throwIfAborted();
    let wait = 0;
    let response: Response | undefined;
    try {
      response = await fetchFile(url, { ...init, signal });
    } catch (err) {
      signal.throwIfAborted();
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // A refusal of the answer itself (where a redirect led) is final: asking again changes nothing.
      if (isJobError(err)) throw err;
      const transport = transportFailure(err, url, "request");
      // No response arrived. A certificate the browser rejected stays rejected.
      failure = transport instanceof TransferError ? transport : new TransferError("network", { url, during: "request" });
      if (!failure.retryable) break;
    }

    if (response) {
      if (response.ok) return response;
      await response.body?.cancel().catch(() => undefined);
      const retryAfter = retryAfterMs(response.headers.get("retry-after"));
      const retryable = isRetryableStatus(cls, response.status) && (retryAfter ?? 0) <= MAX_AUTOMATIC_WAIT_MS;
      failure = new TransferError("http-status", { url: response.url || url, status: response.status, retryAfterMs: retryAfter }, retryable);
      if (!retryable) break;
      wait = retryAfter ?? 0;
    }

    if (attempt === maxAttempts - 1) break;
    await delay(Math.max(computeBackoffMs(cls, attempt, Math.random()), wait), signal);
  }

  // The retries are spent: a caller that retries whole operations must not repeat this one at once. A failure
  // that could still be retried says so, for a caller that waits out an outage before it asks again.
  throw failure.with(failure.retryable ? { retriesSpent: true } : {}, false);
}
