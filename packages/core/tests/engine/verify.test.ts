import { describe, expect, it } from "vitest";
import { verify, type UnverifiedOutput, type VerifyCheck } from "../../src/engine/verify";

const sample: UnverifiedOutput = {
  path: "/tmp/out.mp4",
  bytes: 1_000_000,
  checksum: "abc123",
};

describe("verify", () => {
  it("returns success when all checks pass", async () => {
    const checks: VerifyCheck[] = [
      { kind: "segment-count", expected: 10, got: 10 },
      { kind: "byte-checksum", algo: "sha256", expected: "abc123", got: "abc123" },
    ];
    const r = await verify(sample, checks);
    expect(r.kind).toBe("success");
    if (r.kind === "success") {
      expect(r.output.path).toBe("/tmp/out.mp4");
    }
  });

  it("returns failure on segment-count mismatch", async () => {
    const checks: VerifyCheck[] = [{ kind: "segment-count", expected: 10, got: 9 }];
    const r = await verify(sample, checks);
    expect(r.kind).toBe("failure");
    if (r.kind === "failure") expect(r.error.code).toBe("verification_segment_count");
  });

  it("returns failure on checksum mismatch", async () => {
    const checks: VerifyCheck[] = [{ kind: "byte-checksum", algo: "sha256", expected: "abc", got: "def" }];
    const r = await verify(sample, checks);
    expect(r.kind).toBe("failure");
    if (r.kind === "failure") expect(r.error.code).toBe("verification_checksum");
  });
});
