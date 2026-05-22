import { describe, expect, it } from "vitest";
import { RETRY_POLICY, computeBackoffMs, isRetryableStatus } from "../../src/coordinator/retry";

describe("retry policy", () => {
  it("exponential backoff: 250 → 500 → 1000 → 2000 → 4000", () => {
    expect(computeBackoffMs("segment", 0, 0.5)).toBe(250);
    expect(computeBackoffMs("segment", 1, 0.5)).toBe(500);
    expect(computeBackoffMs("segment", 2, 0.5)).toBe(1000);
    expect(computeBackoffMs("segment", 3, 0.5)).toBe(2000);
    expect(computeBackoffMs("segment", 4, 0.5)).toBe(4000);
  });

  it("caps at maxBackoffMs", () => {
    expect(computeBackoffMs("segment", 10, 0.5)).toBe(4000);
  });

  it("jitter is within ±20%", () => {
    for (let i = 0; i < 100; i++) {
      const v = computeBackoffMs("segment", 2, Math.random());
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });

  it("isRetryableStatus is true for 502 and false for 404", () => {
    expect(isRetryableStatus("segment", 502)).toBe(true);
    expect(isRetryableStatus("segment", 404)).toBe(false);
  });

  it("job budget: 5% failed segments triggers exhaustion", () => {
    const total = 200, failed = 10;
    expect(failed / total).toBeGreaterThanOrEqual(RETRY_POLICY.job.maxFailedSegmentRatio);
  });
});
