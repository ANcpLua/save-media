declare const STREAM_ID_BRAND: unique symbol;
export type StreamId = string & { readonly [STREAM_ID_BRAND]: true };

declare const VARIANT_ID_BRAND: unique symbol;
export type VariantId = string & { readonly [VARIANT_ID_BRAND]: true };

declare const RENDITION_ID_BRAND: unique symbol;
export type AudioRenditionId = string & { readonly [RENDITION_ID_BRAND]: true };

export type ProtocolFamily = "progressive-http" | "hls" | "dash" | "unknown";

export type Container =
  | "mp4" | "mov" | "webm" | "mkv"
  | "mpegts" | "fmp4" | "cmaf"
  | "unknown";

export type OutputContainer = "mp4" | "mov" | "webm" | "mkv" | "mpegts";

export type ConfidenceLevel = "guessed" | "probable" | "confirmed";

export interface Confidence {
  readonly container: ConfidenceLevel;
  readonly codecs: ConfidenceLevel;
  readonly protocol: ConfidenceLevel;
}

export interface OutputCapabilities {
  readonly directDownload: boolean;
  readonly remuxableTo: readonly OutputContainer[];
}

export type DrmReason = "cdm_required" | "clearkey_deferred";

export type DrmSignalSource =
  | "eme-hook"
  | "hls-ext-x-key"
  | "mpeg-ts"
  | "dash-content-protection"
  | "mp4-protection"
  /** ContentEncryption declared in a WebM or Matroska track. */
  | "matroska-protection"
  | "clearkey-detector";

export type DrmStatus =
  | null
  | {
      readonly reason: DrmReason;
      readonly detectedVia: readonly DrmSignalSource[];
      readonly keySystem: string | null;
    };

export type StreamSource =
  | {
      readonly kind: "direct-url";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
      /** Destination observed when probing a browser-visible redirect. */
      readonly finalUrl?: string;
    }
  | { readonly kind: "hls-manifest"; readonly manifestUrl: string; readonly type: "master" | "media" }
  | { readonly kind: "dash-manifest"; readonly manifestUrl: string }
  | { readonly kind: "media-element"; readonly element: "video" | "audio"; readonly elementSrc: string };

import type { CodecSet, Variant } from "./codec";

/** What a playlist or manifest states about its timeline. */
export interface Presentation {
  /** The stream is still being produced: its playlist has no end yet. */
  readonly live: boolean;
  readonly durationSeconds: number | null;
  /** The longest segment the manifest states, the bound for matching a player's duration. */
  readonly maxSegmentSeconds: number | null;
}

export interface StreamDescriptor {
  readonly id: StreamId;
  readonly tabId: number;
  readonly pageUrl: string;
  readonly title: string | null;
  readonly detectedAt: number;
  readonly source: StreamSource;
  readonly protocol: ProtocolFamily;
  readonly container: Container;
  readonly codecs: CodecSet;
  readonly variants: readonly Variant[];
  /** Related direct files explicitly declared by one player configuration. */
  readonly mediaGroup?: string;
  /**
   * Demuxed audio renditions (HLS EXT-X-MEDIA TYPE=AUDIO with URI, DASH audio
   * AdaptationSets), reused as audio-only {@link Variant}s (videoCodec null,
   * audioRenditionId set). A video variant links its rendition through
   * `variant.audioRenditionId`. For HLS masters the rendition's segment URLs
   * are NOT materialized at parse time — `segmentRef.playlistUrl` carries the
   * rendition media playlist, and callers must fetch it and materialize
   * `segmentUrls` (plus the variant's) before dispatch can emit an av-merge
   * plan. Absent/empty means the source has no demuxed audio.
   */
  readonly audioRenditions?: readonly Variant[];
  readonly drm: DrmStatus;
  readonly capabilities: OutputCapabilities;
  readonly confidence: Confidence;
  /** Set for media playlists and DASH manifests. A master playlist states no timeline of its own. */
  readonly presentation?: Presentation;
  /**
   * Listed from the answer the browser itself received, without a request by savemedia: an address a
   * page's ad response named. What it is, is taken from that answer's headers alone. Its bytes are
   * checked when the user saves it, and never before.
   */
  readonly unchecked?: true;
}
