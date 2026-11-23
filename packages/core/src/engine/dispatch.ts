import type {
  StreamDescriptor,
  Container,
  OutputContainer,
} from "../types/stream";
import type {
  JobPlan,
  JobStep,
  UserChoice,
  DispatchRefusal,
  DirectPlan,
  HlsPlainPlan,
  AvMergePlan,
  MergeTrack,
  UnsupportedCodec,
} from "../types/job";
import type { Variant, SegmentRef, VideoCodecFamily, AudioCodecFamily } from "../types/codec";
import { declarationOf, planHlsKeys } from "../parser/hls/keys";

function asOutputContainer(c: Container): OutputContainer {
  if (c === "mp4" || c === "webm" || c === "mkv") return c;
  return "mp4";
}

/** Rank the renditions of one video using quality declared by the publisher. */
export function compareVideoQuality(a: Variant | null, b: Variant | null): number {
  return (b?.height ?? 0) - (a?.height ?? 0)
    || (b?.width ?? 0) - (a?.width ?? 0)
    || (b?.frameRate ?? 0) - (a?.frameRate ?? 0)
    || (b?.bitrate ?? 0) - (a?.bitrate ?? 0);
}

export function pickVariant(descriptor: StreamDescriptor, choice: UserChoice): Variant | null {
  if (descriptor.variants.length === 0) return null;
  if (choice.variantId) {
    for (const v of descriptor.variants) if (v.id === choice.variantId) return v;
  }
  return [...descriptor.variants].sort(compareVideoQuality)[0] ?? null;
}

function estimateSize(variant: Variant | null): number | null {
  if (!variant) return null;
  if (variant.estimatedSize != null) return variant.estimatedSize;
  return null;
}

function resolveOutputContainer(descriptor: StreamDescriptor, choice: UserChoice): OutputContainer {
  void choice;
  return asOutputContainer(descriptor.container);
}

function audioRenditionsOf(descriptor: StreamDescriptor): readonly Variant[] {
  return descriptor.audioRenditions ?? [];
}

/**
 * The key policy over every key the variants and renditions carry. Their
 * KEYFORMAT travels with them, so a CDM key system is never mistaken for a
 * key served in the clear. Descriptor-level DRM was refused before this.
 */
function hlsEncryptionFor(descriptor: StreamDescriptor): "clear" | "encrypted" | "drm-blocked" {
  const declarations = [...descriptor.variants, ...audioRenditionsOf(descriptor)].flatMap(v =>
    v.segmentRef.kind === "hls-segments" && v.segmentRef.encryption ? [declarationOf(v.segmentRef.encryption)] : []);
  const plan = planHlsKeys(declarations);
  return plan.kind === "drm" ? "drm-blocked" : plan.kind === "aes-128" ? "encrypted" : "clear";
}

function buildHlsPlainPlan(
  _descriptor: StreamDescriptor,
  choice: UserChoice,
  variant: Variant,
  outputContainer: OutputContainer,
): HlsPlainPlan {
  const estimatedBytes = estimateSize(variant);
  const steps: JobStep[] = [
    { op: "remux", toContainer: outputContainer },
    { op: "verify", checks: ["segment-count", "container-validity"] },
    { op: "finalize", sink: "downloads" },
  ];
  return {
    kind: "hls-plain",
    steps,
    outputContainer,
    outputFilename: choice.filename,
    variantId: variant.id,
    estimatedBytes,
  };
}

function buildDirectPlan(descriptor: StreamDescriptor, choice: UserChoice): DirectPlan | null {
  if (descriptor.source.kind !== "direct-url") return null;
  return { kind: "direct", url: descriptor.source.url, filename: choice.filename };
}

function combinedEstimate(video: Variant, audio: Variant | null): number | null {
  const v = video.estimatedSize;
  const a = audio?.estimatedSize ?? null;
  if (v == null && a == null) return null;
  return (v ?? 0) + (a ?? 0);
}

/**
 * A merge track needs concrete fetchable URLs; a ref whose segment list has
 * not been materialized (or that needs byte-range fetches) yields null and
 * the caller must refuse rather than emit an unrunnable plan.
 */
function mergeTrackFrom(ref: SegmentRef): MergeTrack | null {
  switch (ref.kind) {
    case "direct":
      return { initUrl: null, segmentUrls: [ref.url] };
    case "hls-segments":
      if (ref.segmentUrls.length === 0) return null;
      return { initUrl: ref.initSegmentUrl, segmentUrls: ref.segmentUrls,
        ...(ref.segmentKeys ? { segmentKeys: ref.segmentKeys } : {}), ...(ref.initKey ? { initKey: ref.initKey } : {}),
        ...(ref.fileBytes !== undefined ? { fileBytes: ref.fileBytes } : {}), ...(ref.fileGaps?.length ? { fileGaps: ref.fileGaps } : {}) };
    case "dash-segments":
      if (ref.mediaUrls.length === 0) return null;
      return { initUrl: ref.initUrl || null, segmentUrls: ref.mediaUrls, ...(ref.fileBytes !== undefined ? { fileBytes: ref.fileBytes } : {}) };
    case "byte-range":
      return null;
  }
}

// The merge engine muxes to MP4, and these are the families its muxer writes
// there, whatever container the segments arrive in (fMP4, WebM, MPEG-TS).
// A family outside them cannot be put into the file, so its plan is refused
// before anything is fetched. A null codec passes: a manifest need not
// declare one, and the muxer reads it from the bytes.
const MP4_VIDEO_FAMILIES: ReadonlySet<VideoCodecFamily> = new Set(["h264", "h265", "av1", "vp9", "vp8"]);
const MP4_AUDIO_FAMILIES: ReadonlySet<AudioCodecFamily> = new Set(["aac", "mp3", "opus", "flac", "vorbis", "ac3", "eac3"]);

/** The declared codec the MP4 file cannot hold, if a track declares one. */
function codecOutsideMp4(video: Variant, audio: Variant | null): UnsupportedCodec | null {
  if (video.videoCodec && !MP4_VIDEO_FAMILIES.has(video.videoCodec.family)) return { track: "video", family: video.videoCodec.family };
  // A demuxed HLS variant's CODECS attribute declares the group's audio
  // codec; the rendition itself usually carries none. Without a separate
  // audio track, the video track's own declared audio is what is copied.
  const audioCodec = audio?.audioCodec ?? video.audioCodec;
  if (audioCodec && !MP4_AUDIO_FAMILIES.has(audioCodec.family)) return { track: "audio", family: audioCodec.family };
  return null;
}

function mp4MergeCompatible(video: Variant, audio: Variant | null): boolean {
  return codecOutsideMp4(video, audio) === null;
}

/** A track is clear, or its media playlist was read and names the key of each segment. */
function keysKnown(track: Variant): boolean {
  const ref = track.segmentRef;
  if (ref.kind !== "hls-segments") return true;
  return ref.segmentKeys?.length === ref.segmentUrls.length || (ref.encryption === null && ref.initKey == null);
}

/**
 * `audio` null: the manifest declares no separate audio track, and the video
 * track is saved as the page plays it, with the sound its own bytes carry
 * (one representation can hold video and audio together) or without sound.
 */
function buildAvMergePlan(video: Variant, audio: Variant | null, choice: UserChoice): AvMergePlan | null {
  if (!mp4MergeCompatible(video, audio)) return null;
  const videoTrack = mergeTrackFrom(video.segmentRef);
  const audioTrack = audio ? mergeTrackFrom(audio.segmentRef) : null;
  if (!videoTrack || (audio && !audioTrack)) return null;
  return {
    kind: "av-merge",
    video: videoTrack,
    audio: audioTrack,
    // The merge engine muxes to MP4 only.
    outputContainer: "mp4",
    outputFilename: choice.filename,
    estimatedBytes: combinedEstimate(video, audio),
  };
}

export function pickHlsAudioRendition(
  descriptor: StreamDescriptor,
  variant: Variant,
  choice: UserChoice,
): Variant | null {
  const renditions = audioRenditionsOf(descriptor);
  if (choice.audioRenditionId) {
    const chosen = renditions.find(r => r.audioRenditionId === choice.audioRenditionId);
    if (chosen) return chosen;
  }
  return renditions.find(r => r.audioRenditionId === variant.audioRenditionId) ?? null;
}

/** A clear HLS master can name a playable pair before its child playlists load. */
export function hasPendingHlsPair(descriptor: StreamDescriptor, choice: UserChoice): boolean {
  if (descriptor.protocol !== "hls" || descriptor.drm) return false;
  const video = pickVariant(descriptor, choice);
  if (!video?.audioRenditionId) return false;
  const audio = pickHlsAudioRendition(descriptor, video, choice);
  if (!audio || !mp4MergeCompatible(video, audio)) return false;
  return video.segmentRef.kind === "hls-segments" && audio.segmentRef.kind === "hls-segments"
    && (!video.segmentRef.segmentUrls.length || !audio.segmentRef.segmentUrls.length);
}

function pickDashAudioRendition(descriptor: StreamDescriptor, choice: UserChoice): Variant | null {
  const renditions = audioRenditionsOf(descriptor);
  if (choice.audioRenditionId) {
    const chosen = renditions.find(r => r.audioRenditionId === choice.audioRenditionId);
    if (chosen) return chosen;
  }
  const sorted = [...renditions].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return sorted[0] ?? null;
}

export function dispatch(descriptor: StreamDescriptor, choice: UserChoice): JobPlan | DispatchRefusal {
  if (descriptor.drm) {
    return { kind: "refuse", reason: descriptor.drm.reason };
  }
  // A playlist that is still being written has no complete file to save yet.
  if (descriptor.protocol === "hls" && descriptor.presentation?.live) {
    return { kind: "refuse", reason: "hls_live_unsupported" };
  }

  // Direct download: progressive + Original mode + actual direct URL.
  if (descriptor.capabilities.directDownload && choice.outputMode === "Original") {
    const direct = buildDirectPlan(descriptor, choice);
    if (direct) return direct;
  }

  const outputContainer = resolveOutputContainer(descriptor, choice);

  // HLS: classify per-variant encryption to pick plain vs AES vs blocked.
  if (descriptor.protocol === "hls") {
    const variant = pickVariant(descriptor, choice);
    if (!variant) return { kind: "refuse", reason: "no_usable_variant" };
    const demuxed = variant.audioRenditionId !== null;
    const audio = demuxed ? pickHlsAudioRendition(descriptor, variant, choice) : null;
    const enc = hlsEncryptionFor(descriptor);
    if (enc === "drm-blocked") {
      return { kind: "refuse", reason: "cdm_required" };
    }
    if (demuxed) {
      // A codec the MP4 file cannot hold is said as that. It is no fault of the playlist, and no new look
      // at the page changes it.
      const codec = codecOutsideMp4(variant, audio);
      if (codec) return { kind: "refuse", reason: "codec_unsupported", codec };
      // A demuxed variant must never fall back to hls-plain — that would save
      // a silent video-only file. Until both tracks carry materialized segment
      // URLs (the caller fetches the media playlists first), refuse.
      const plan = audio ? buildAvMergePlan(variant, audio, choice) : null;
      // AES-128 with an identity key is decrypted: the engine fetches the 16
      // key bytes over the same HTTP the player uses. The materialized tracks
      // name the key of every segment; a keyed track without that list would
      // be merged as ciphertext, so it is refused.
      if (plan && enc === "encrypted" && ![variant, audio].every(track => !track || keysKnown(track))) {
        return { kind: "refuse", reason: "hls_encryption_unsupported" };
      }
      return plan ?? { kind: "refuse", reason: "no_usable_variant" };
    }
    return buildHlsPlainPlan(descriptor, choice, variant, outputContainer);
  }

  // DASH: the clear video track and the audio track that belongs to it become
  // one MP4. A manifest that declares no separate audio track is saved as it
  // plays: with the sound the video track's own bytes carry, or without
  // sound. It is clear media the browser receives. What stays refused is what
  // cannot be assembled: a manifest still being written (parseDash leaves a
  // dynamic MPD unmaterialized, because it lists only the current window),
  // byte ranges that do not add up to one file, a codec the MP4 muxer does
  // not write, and an audio track that exists but cannot be fetched, which is
  // never dropped silently. DRM was already refused at the top.
  if (descriptor.protocol === "dash") {
    const variant = pickVariant(descriptor, choice);
    if (!variant) return { kind: "refuse", reason: "no_usable_variant" };
    if (descriptor.presentation?.live) {
      return { kind: "refuse", reason: "hls_live_unsupported" };
    }
    const audio = pickDashAudioRendition(descriptor, choice);
    const codec = codecOutsideMp4(variant, audio);
    if (codec) return { kind: "refuse", reason: "codec_unsupported", codec };
    const plan = buildAvMergePlan(variant, audio, choice);
    if (!plan) {
      return { kind: "refuse", reason: "dash_unsupported" };
    }
    return plan;
  }

  // Progressive: pick direct if Original (or the requested output already
  // matches the on-the-wire container). Browser-only conversion of
  // arbitrary progressive files is intentionally disabled until covered
  // by real golden-media tests.
  if (descriptor.protocol === "progressive-http") {
    const direct = buildDirectPlan(descriptor, choice);
    if (direct && descriptor.capabilities.directDownload) {
      return direct;
    }
    return { kind: "refuse", reason: "unsupported_output" };
  }

  return { kind: "refuse", reason: "unsupported_output" };
}

export type { DirectPlan, HlsPlainPlan };
