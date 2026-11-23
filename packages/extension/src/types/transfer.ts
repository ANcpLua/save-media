import { z } from "zod";

/**
 * The name under which the engine keeps a failed direct save's bytes for
 * Retry save. The background stores it with the failure, so that after a
 * worker restart it can tell whether the engine still holds those bytes.
 */
export function directResumeScope(tabId: number | undefined, resumeKey: string): string {
  return `direct:${tabId}:${resumeKey}`;
}

/**
 * The closed set of transfer stages. The engine, the background and Chrome's
 * own resume report only these values; English is written from them in
 * util/transfer-progress.ts and nowhere else, and is never parsed back.
 */
export type TransferStage =
  | { readonly kind: "starting" }
  | { readonly kind: "probing" }
  | { readonly kind: "playlist" }
  | { readonly kind: "downloading" }
  /** HLS segment `index` of `count`, 1-based. */
  | { readonly kind: "segment"; readonly index: number; readonly count: number }
  | { readonly kind: "track"; readonly track: "video" | "audio" }
  | {
      readonly kind: "retrying";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly waitMs: number;
      readonly httpStatus: number | null;
      /** The file part being retried, 1-based, when the file is fetched in parts. */
      readonly part: { readonly index: number; readonly count: number } | null;
    }
  /** An outage while the save holds bytes of a file or parts of a stream: it goes on after the wait, with what it holds. */
  | { readonly kind: "reconnecting"; readonly waitMs: number }
  | { readonly kind: "resuming" }
  | { readonly kind: "rechecking" }
  | { readonly kind: "restarting"; readonly cause: "retained-rejected" | "ranges-unusable" }
  | { readonly kind: "remuxing"; readonly fraction: number | null }
  | { readonly kind: "merging"; readonly fraction: number | null }
  | { readonly kind: "verifying" }
  | { readonly kind: "finalizing" }
  | { readonly kind: "writing" };

export interface TransferProgress {
  readonly stage: TransferStage;
  readonly bytesWritten: number;
  readonly bytesTotal: number | null;
}

/** Bytes of a failed direct save the engine keeps, until `expiresAt`, for a Retry save in the same tab. */
export interface RetainedPartial {
  readonly bytes: number;
  readonly total: number;
  readonly expiresAt: number;
}

const count = z.number().int().nonnegative();
const fraction = z.number().min(0).max(1).nullable();

export const transferStageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starting") }),
  z.object({ kind: z.literal("probing") }),
  z.object({ kind: z.literal("playlist") }),
  z.object({ kind: z.literal("downloading") }),
  z.object({ kind: z.literal("segment"), index: count, count }),
  z.object({ kind: z.literal("track"), track: z.enum(["video", "audio"]) }),
  z.object({ kind: z.literal("retrying"), attempt: count, maxAttempts: count, waitMs: count,
    httpStatus: count.max(599).nullable(), part: z.object({ index: count, count }).nullable() }),
  z.object({ kind: z.literal("reconnecting"), waitMs: count }),
  z.object({ kind: z.literal("resuming") }),
  z.object({ kind: z.literal("rechecking") }),
  z.object({ kind: z.literal("restarting"), cause: z.enum(["retained-rejected", "ranges-unusable"]) }),
  z.object({ kind: z.literal("remuxing"), fraction }),
  z.object({ kind: z.literal("merging"), fraction }),
  z.object({ kind: z.literal("verifying") }),
  z.object({ kind: z.literal("finalizing") }),
  z.object({ kind: z.literal("writing") }),
]);

export const retainedPartialSchema = z.object({ bytes: count, total: count, expiresAt: count });
