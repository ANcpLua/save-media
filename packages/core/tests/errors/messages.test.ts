import { describe, expect, it } from "vitest";
import { userMessage } from "../../src/errors/messages";
import type { JobError } from "../../src/errors/taxonomy";

describe("userMessage", () => {
  it("DRM errors produce a 'Protected stream' title", () => {
    const err: JobError = { code: "cdm_required", severity: "terminal", keySystem: "com.widevine.alpha" };
    const msg = userMessage(err);
    expect(msg.title).toMatch(/protected/i);
    expect(msg.action).toBeNull();
  });

  it("clearkey_deferred is distinct from DRM and does not promise future support", () => {
    const err: JobError = { code: "clearkey_deferred", severity: "terminal", manifestUrl: "https://example.com/m.mpd" };
    const msg = userMessage(err);
    expect(msg.title).toMatch(/not implemented/i);
    expect(msg.body).toMatch(/does not implement/i);
  });

  it("verification_checksum returns the retry action", () => {
    const err: JobError = {
      code: "verification_checksum", severity: "terminal", algo: "sha256",
      expected: "abc", got: "def",
    };
    const msg = userMessage(err);
    expect(msg.action?.kind).toBe("retry-job");
  });

  it("user_cancelled mentions discarded bytes", () => {
    const err: JobError = { code: "user_cancelled", severity: "terminal", bytesDiscarded: 12_345_678 };
    expect(userMessage(err).body).toMatch(/12\.3 MB/);
  });

  it("rate_limited has a distinct retryable user message", () => {
    const err: JobError = {
      code: "rate_limited",
      severity: "terminal",
      phase: "segment",
      url: "https://cdn.example/seg.ts",
      httpStatus: 429,
      retryAfterSeconds: 10,
    };
    const msg = userMessage(err);
    expect(msg.title).toMatch(/rate-limited/i);
    expect(msg.action?.kind).toBe("retry-job");
  });

  it("access_denied does not pretend paid/account-gated content is DRM", () => {
    const err: JobError = {
      code: "access_denied",
      severity: "terminal",
      phase: "direct",
      url: "https://cdn.example/private.mp4",
      httpStatus: 402,
      explanation: "payment-or-entitlement",
    };
    expect(userMessage(err).body).toMatch(/access control, not automatically DRM/i);
  });
});
