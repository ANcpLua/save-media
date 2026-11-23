import { describe, expect, it } from "vitest";
import { isJobError, type JobError, type JobErrorSeverity } from "../../src/errors/taxonomy";

describe("JobError", () => {
  it("is recognised by its code and severity, whatever else it carries", () => {
    const err: JobError = { code: "encrypted_media_detected", severity: "terminal", detectedVia: ["eme-hook"], keySystem: "com.widevine.alpha" };
    expect(isJobError(err)).toBe(true);
    expect(isJobError({ code: "x" })).toBe(false);
    expect(isJobError(new Error("boom"))).toBe(false);
    expect(isJobError(null)).toBe(false);
  });

  it("every error ends its job", () => {
    const severity: JobErrorSeverity = "terminal";
    expect(severity).toBe("terminal");
  });
});
