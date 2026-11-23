import type { VariantId, AudioRenditionId } from "./stream";
import type { FileRange } from "../parser/byte-ranges";
export type { VariantId, AudioRenditionId };

export type VideoCodecFamily =
  | "h264" | "h265" | "vp8" | "vp9" | "av1"
  | "mpeg4-part2" | "prores" | "unknown";

export type AudioCodecFamily =
  | "aac" | "mp3" | "opus" | "vorbis" | "flac" | "pcm"
  | "alac" | "ac3" | "eac3" | "unknown";

export interface VideoCodec {
  readonly rfc6381: string;
  readonly family: VideoCodecFamily;
  readonly profile: string | null;
  readonly level: string | null;
}

export interface AudioCodec {
  readonly rfc6381: string | null;
  readonly family: AudioCodecFamily;
  readonly channels: number | null;
  readonly sampleRate: number | null;
}

export interface SubtitleTrack {
  readonly id: string;
  readonly language: string | null;
  readonly format: "vtt" | "ttml" | "srt" | "unknown";
  readonly url: string;
}

export interface CodecSet {
  readonly video: VideoCodec | null;
  readonly audio: AudioCodec | null;
  readonly subtitles: readonly SubtitleTrack[];
}

export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface HlsEncryption {
  readonly method: "AES-128" | "SAMPLE-AES" | "SAMPLE-AES-CTR";
  readonly keyUri: string;
  readonly iv: Uint8Array | null;
  /** KEYFORMAT lowercased. Absent means identity (RFC 8216 4.3.2.4). */
  readonly keyFormat?: string;
}

/** The AES-128 key that covers one HLS media segment or init section, as its media playlist declares it. */
export interface HlsSegmentKey {
  readonly keyUri: string;
  /** The IV attribute; null derives the IV from `mediaSequence` (RFC 8216 section 5.2). */
  readonly iv: Uint8Array | null;
  readonly mediaSequence: number;
}

export type SegmentRef =
  | { readonly kind: "direct"; readonly url: string }
  | { readonly kind: "byte-range"; readonly url: string; readonly range: ByteRange }
  | {
      readonly kind: "hls-segments";
      readonly playlistUrl: string;
      readonly initSegmentUrl: string | null;
      readonly segmentUrls: readonly string[];
      readonly encryption: HlsEncryption | null;
      /**
       * Set when the engine has read the media playlist: per segment, aligned
       * with `segmentUrls`, the key that covers it, or null for a clear one.
       */
      readonly segmentKeys?: readonly (HlsSegmentKey | null)[];
      /** The key covering the init section, when an EXT-X-KEY precedes EXT-X-MAP. */
      readonly initKey?: HlsSegmentKey | null;
      /**
       * Set when the playlist's parts are byte ranges of one file: `segmentUrls`
       * is then that file alone, and this is where the ranges say it ends.
       */
      readonly fileBytes?: number;
      /** With `fileBytes`: the stretches of the file no range names. The file is the stream only when they hold no media. */
      readonly fileGaps?: readonly FileRange[];
    }
  | {
      readonly kind: "dash-segments";
      readonly initUrl: string;
      readonly mediaUrls: readonly string[];
      /**
       * Set when `mediaUrls` is the one file a representation is kept in and
       * the manifest's byte ranges state where it ends: the file's length.
       */
      readonly fileBytes?: number;
    };

export interface Variant {
  readonly id: VariantId;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly bitrate: number | null;
  /**
   * The track's size in bytes. Next to a `bitrate` it was worked out from
   * that rate over the track's length: an estimate that leans high (HLS
   * BANDWIDTH is the peak rate). Without one it is the length a server
   * declared for the file.
   */
  readonly estimatedSize: number | null;
  readonly videoCodec: VideoCodec | null;
  readonly audioCodec: AudioCodec | null;
  readonly audioRenditionId: AudioRenditionId | null;
  readonly segmentRef: SegmentRef;
}
