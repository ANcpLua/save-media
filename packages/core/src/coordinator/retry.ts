export const RETRY_POLICY = {
  segment: {
    maxAttempts: 5,
    baseMs: 250,
    maxBackoffMs: 4000,
    jitterFraction: 0.2,
    retryableStatuses: [408, 425, 429, 500, 502, 503, 504] as readonly number[],
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
    retryableStatuses: [408, 425, 429, 500, 502, 503, 504] as readonly number[],
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
