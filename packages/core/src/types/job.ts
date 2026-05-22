import type { DrmReason, OutputContainer } from "./stream";
import type { VariantId, AudioRenditionId, VideoCodec, ByteRange, HlsEncryption } from "./codec";

export type OutputMode =
  | "Original"
  | "MP4 Compatible"
  | "Best Quality"
  | "Small File"
  | "Manual";

export interface UserChoice {
  readonly outputMode: OutputMode;
  readonly filename: string;
  readonly variantId: VariantId | null;
  readonly audioRenditionId: AudioRenditionId | null;
}

export interface DispatchRefusal {
  readonly kind: "refuse";
  readonly reason: DrmReason;
}

declare const KEY_HANDLE_BRAND: unique symbol;
export type KeyHandle = string & { readonly [KEY_HANDLE_BRAND]: true };

export type VerifyCheckKind =
  | "segment-count" | "duration" | "byte-checksum" | "container-validity";

export type JobStep =
  | { readonly op: "fetch-init-segment"; readonly url: string; readonly range?: ByteRange }
  | { readonly op: "fetch-key"; readonly url: string }
  | { readonly op: "fetch-segment"; readonly index: number; readonly url: string; readonly range?: ByteRange; readonly iv?: Uint8Array }
  | { readonly op: "decrypt-aes-128"; readonly segmentIndex: number; readonly keyHandle: KeyHandle }
  | { readonly op: "remux"; readonly engine: "mediabunny"; readonly toContainer: OutputContainer }
  | { readonly op: "transcode"; readonly engine: "ffmpeg-wasm" | "native-ffmpeg"; readonly from: VideoCodec; readonly to: VideoCodec }
  | { readonly op: "verify"; readonly checks: readonly VerifyCheckKind[] }
  | { readonly op: "finalize"; readonly sink: "downloads" | "native-streaming-sink" };

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
  readonly useNativeSink: boolean;
}

export interface HlsAesPlan {
  readonly kind: "hls-aes";
  readonly steps: readonly JobStep[];
  readonly outputContainer: OutputContainer;
  readonly outputFilename: string;
  readonly variantId: VariantId;
  readonly estimatedBytes: number | null;
  readonly useNativeSink: boolean;
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
  readonly useNativeSink: boolean;
}

export interface RemuxPlan {
  readonly kind: "remux";
  readonly steps: readonly JobStep[];
  readonly fromContainer: OutputContainer;
  readonly outputContainer: OutputContainer;
  readonly outputFilename: string;
  readonly estimatedBytes: number | null;
}

export interface TranscodePlan {
  readonly kind: "transcode";
  readonly steps: readonly JobStep[];
  readonly outputContainer: OutputContainer;
  readonly outputFilename: string;
  readonly fromVideoCodec: VideoCodec;
  readonly toVideoCodec: VideoCodec;
  readonly engine: "ffmpeg-wasm" | "native-ffmpeg";
}

export type JobPlan = DirectPlan | HlsPlainPlan | HlsAesPlan | DashPlan | RemuxPlan | TranscodePlan;
