import type { DrmReason, OutputContainer } from "./stream";
import type { VariantId, AudioRenditionId, ByteRange, HlsEncryption } from "./codec";

export type OutputMode = "Original";

export interface UserChoice {
  readonly outputMode: OutputMode;
  readonly filename: string;
  readonly variantId: VariantId | null;
  readonly audioRenditionId: AudioRenditionId | null;
}

export interface DispatchRefusal {
  readonly kind: "refuse";
  readonly reason: DispatchRefusalReason;
}

export type DispatchRefusalReason =
  | DrmReason
  | "no_usable_variant"
  | "unsupported_output"
  | "output_too_large_for_browser";

declare const KEY_HANDLE_BRAND: unique symbol;
export type KeyHandle = string & { readonly [KEY_HANDLE_BRAND]: true };

export type VerifyCheckKind =
  | "segment-count" | "duration" | "byte-checksum" | "container-validity";

export type JobStep =
  | { readonly op: "fetch-init-segment"; readonly url: string; readonly range?: ByteRange }
  | { readonly op: "fetch-key"; readonly url: string }
  | { readonly op: "fetch-segment"; readonly index: number; readonly url: string; readonly range?: ByteRange; readonly iv?: Uint8Array }
  | { readonly op: "decrypt-aes-128"; readonly segmentIndex: number; readonly keyHandle: KeyHandle }
  | { readonly op: "remux"; readonly toContainer: OutputContainer }
  | { readonly op: "verify"; readonly checks: readonly VerifyCheckKind[] }
  | { readonly op: "finalize"; readonly sink: "downloads" };

export interface DirectPlan {
  readonly kind: "direct";
  readonly url: string;
  readonly filename: string;
}

export interface HlsPlainPlan {
  readonly kind: "hls-plain";
  readonly steps: readonly JobStep[];
  readonly outputContainer: OutputContainer;
  readonly outputFilename: string;
  readonly variantId: VariantId;
  readonly estimatedBytes: number | null;
}

export interface HlsAesPlan {
  readonly kind: "hls-aes";
  readonly steps: readonly JobStep[];
  readonly outputContainer: OutputContainer;
  readonly outputFilename: string;
  readonly variantId: VariantId;
  readonly estimatedBytes: number | null;
  readonly keyUri: string;
  readonly encryption: HlsEncryption;
}

export interface DashPlan {
  readonly kind: "dash";
  readonly steps: readonly JobStep[];
  readonly outputContainer: OutputContainer;
  readonly outputFilename: string;
  readonly variantId: VariantId;
  readonly audioRenditionId: AudioRenditionId | null;
  readonly estimatedBytes: number | null;
}

export type JobPlan = DirectPlan | HlsPlainPlan | HlsAesPlan | DashPlan;
