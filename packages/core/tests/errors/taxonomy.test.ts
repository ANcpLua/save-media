import { describe, expect, it } from "vitest";
import type { JobError, JobErrorSeverity } from "../../src/errors/taxonomy";
import { isTerminal, isRecoverable } from "../../src/errors/taxonomy";

describe("JobError", () => {
  it("encrypted_media_detected is terminal", () => {
    const err: JobError = {
      code: "encrypted_media_detected",
      severity: "terminal",
      detectedVia: ["eme-hook"],
      keySystem: "com.widevine.alpha",
    };
    expect(isTerminal(err)).toBe(true);
  });

  it("segment_fetch_failed is recoverable", () => {
    const err: JobError = {
      code: "segment_fetch_failed",
      severity: "recoverable",
      segmentIndex: 42,
      url: "https://example.com/seg42.ts",
      httpStatus: 502,
      attemptsRemaining: 3,
    };
    expect(isRecoverable(err)).toBe(true);
  });

  it("severity type is the literal union", () => {
    const sev: JobErrorSeverity = "terminal";
    expect(sev).toBe("terminal");
  });
});
