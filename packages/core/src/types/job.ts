import type { DrmReason, OutputContainer } from "./stream";
import type { VariantId, AudioRenditionId, ByteRange, HlsSegmentKey, VideoCodecFamily, AudioCodecFamily } from "./codec";
import type { FileRange } from "../parser/byte-ranges";

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
  /** With output_too_large_for_browser: the stated size that was compared with the limit, video and audio together. */
  readonly estimatedBytes?: number;
  /** With codec_unsupported: the declared codec the MP4 file cannot hold, and which track declares it. */
  readonly codec?: UnsupportedCodec;
}

export interface UnsupportedCodec {
  readonly track: "video" | "audio";
  readonly family: VideoCodecFamily | AudioCodecFamily;
}

export type DispatchRefusalReason =
  | DrmReason
  | "no_usable_variant"
  | "unsupported_output"
  /** A track declares a codec the MP4 muxer does not write. Nothing a new look at the page changes. */
  | "codec_unsupported"
  | "output_too_large_for_browser"
  | "dash_unsupported"
  | "hls_encryption_unsupported"
  | "hls_live_unsupported";

export type VerifyCheckKind =
  | "segment-count" | "duration" | "byte-checksum" | "container-validity";

export type JobStep =
  | { readonly op: "fetch-segment"; readonly index: number; readonly url: string; readonly range?: ByteRange; readonly iv?: Uint8Array }
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

/**
 * One side of a demuxed source: an optional fMP4 init segment followed by the
 * ordered media segments. For a progressive track it is a single URL with no
 * init segment. Concatenating `initUrl` + `segmentUrls` yields a complete,
 * demuxable byte stream (verified against real fragmented fMP4).
 */
export interface MergeTrack {
  readonly initUrl: string | null;
  readonly segmentUrls: readonly string[];
  /** HLS AES-128: per segment, aligned with `segmentUrls`, the key that decrypts it; null for a clear segment. */
  readonly segmentKeys?: readonly (HlsSegmentKey | null)[];
  /** HLS AES-128: the key covering the init section. */
  readonly initKey?: HlsSegmentKey | null;
  /** A track that is one file whose manifest states its length: the track is that many bytes of it, from the start. */
  readonly fileBytes?: number;
  /** With `fileBytes`: the stretches of the file its playlist's byte ranges leave out. They must hold no media. */
  readonly fileGaps?: readonly FileRange[];
}

/**
 * A source that ships its tracks as separate segment lists (demuxed HLS audio
 * groups, DASH): fetch the video track, and the audio track that belongs to
 * it, and mux them into one MP4 with no re-encode. Dispatch emits it for
 * demuxed HLS variants (a linked audio rendition) and for clear DASH, and
 * only once every track carries concrete fetchable URLs — a plan with an
 * unmaterialized track is never emitted.
 *
 * `audio` is null only when the manifest declares no audio at all: the page
 * itself plays that video without sound, and it is saved the same way. A
 * source whose audio exists but cannot be fetched is refused, never saved
 * without it.
 */
export interface AvMergePlan {
  readonly kind: "av-merge";
  readonly video: MergeTrack;
  readonly audio: MergeTrack | null;
  readonly outputContainer: OutputContainer;
  readonly outputFilename: string;
  readonly estimatedBytes: number | null;
}

export type JobPlan = DirectPlan | HlsPlainPlan | AvMergePlan;
