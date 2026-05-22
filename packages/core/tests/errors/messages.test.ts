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

  it("clearkey_deferred uses 'deferred' phrasing, not 'protected'", () => {
    const err: JobError = { code: "clearkey_deferred", severity: "terminal", manifestUrl: "https://example.com/m.mpd" };
    const msg = userMessage(err);
    expect(msg.body).toMatch(/deferred|v2/i);
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
});
