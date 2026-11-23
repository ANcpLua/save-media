// Retry transient HTTP responses, including origin-connectivity failures
// returned by a reverse proxy. Certificate and protocol failures are terminal.
const TRANSIENT_HTTP_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524];
export const MAX_AUTOMATIC_WAIT_MS = 30_000;

export const RETRY_POLICY = {
  segment: {
    maxAttempts: 5,
    baseMs: 250,
    maxBackoffMs: 4000,
    jitterFraction: 0.2,
    retryableStatuses: TRANSIENT_HTTP_STATUSES,
  },
  job: {
    maxFailedSegmentRatio: 0.05,
    maxConsecutiveFailures: 10,
  },
  manifest: {
    maxAttempts: 3,
    baseMs: 500,
    maxBackoffMs: 4000,
    jitterFraction: 0.2,
    retryableStatuses: TRANSIENT_HTTP_STATUSES,
  },
} as const;

export type RetryClass = "segment" | "manifest";

function isClassWithBackoff(cls: string): cls is RetryClass {
  return cls === "segment" || cls === "manifest";
}

/**
 * Deterministic backoff. jitterSeed ∈ [0, 1). Pass 0.5 in tests for the
 * canonical (no-jitter) value; pass Math.random() in production callers.
 */
export function computeBackoffMs(cls: RetryClass, attempt: number, jitterSeed: number): number {
  if (!isClassWithBackoff(cls)) throw new Error(`unknown retry class: ${cls}`);
  const p = RETRY_POLICY[cls];
  const base = Math.min(p.baseMs * 2 ** attempt, p.maxBackoffMs);
  const jitterRange = base * p.jitterFraction;
  const jitter = (jitterSeed * 2 - 1) * jitterRange;
  return Math.round(base + jitter);
}

export function isRetryableStatus(cls: RetryClass, status: number): boolean {
  if (!isClassWithBackoff(cls)) return false;
  return RETRY_POLICY[cls].retryableStatuses.includes(status);
}

export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const field = value.trim();
  if (/^\d+$/.test(field)) return Number(field) * 1000;
  // Date.parse also accepts inputs such as "-1" and "1.5" as calendar dates.
  if (!/[a-z]/i.test(field)) return undefined;
  const date = Date.parse(field);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
