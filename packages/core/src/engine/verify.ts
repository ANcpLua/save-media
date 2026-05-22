import type { JobError } from "../errors/taxonomy";

// Unique-symbol brand: type-only, never exported.
// External code cannot name this symbol and therefore cannot construct
// a VerifiedOutput from scratch — it must go through verify().
declare const _verified: unique symbol;

export interface UnverifiedOutput {
  readonly path: string;
  readonly bytes: number;
  readonly checksum: string;
}

export interface VerifiedOutput {
  /** Brand tag — not present at runtime; enforced structurally by TypeScript. */
  readonly [_verified]: true;
  readonly path: string;
  readonly bytes: number;
  readonly checksum: string;
  readonly checks: readonly VerifyCheck[];
}

export type VerifyCheck =
  | { kind: "segment-count";      expected: number; got: number }
  | { kind: "duration";           expectedMs: number; gotMs: number; toleranceMs: number }
  | { kind: "byte-checksum";      algo: "sha256"; expected: string; got: string }
  | { kind: "container-validity"; via: "mediabunny-probe" | "mp4box-probe" };

export type VerifyResult =
  | { kind: "success"; output: VerifiedOutput }
  | { kind: "failure"; error: JobError };

export async function verify(
  output: UnverifiedOutput,
  checks: readonly VerifyCheck[],
): Promise<VerifyResult> {
  for (const check of checks) {
    if (check.kind === "segment-count" && check.expected !== check.got) {
      return {
        kind: "failure",
        error: { code: "verification_segment_count", severity: "terminal", expected: check.expected, got: check.got },
      };
    }
    if (check.kind === "duration" && Math.abs(check.expectedMs - check.gotMs) > check.toleranceMs) {
      return {
        kind: "failure",
        error: { code: "verification_duration", severity: "terminal", expectedMs: check.expectedMs, gotMs: check.gotMs, toleranceMs: check.toleranceMs },
      };
    }
    if (check.kind === "byte-checksum" && check.expected !== check.got) {
      return {
        kind: "failure",
        error: { code: "verification_checksum", severity: "terminal", algo: check.algo, expected: check.expected, got: check.got },
      };
    }
    // container-validity: no-op in Plan 1; real probe wired in Plan 3.
  }

  // Cast is safe: this is the only site that produces VerifiedOutput.
  // The brand property [_verified] is type-only — no runtime overhead.
  const branded = {
    path: output.path,
    bytes: output.bytes,
    checksum: output.checksum,
    checks,
  } as VerifiedOutput;
  return { kind: "success", output: branded };
}
