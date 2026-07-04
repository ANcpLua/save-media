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
} from "../types/job";
import type { Variant, HlsEncryption, SegmentRef } from "../types/codec";
import { interpretHlsEncryption } from "../parser/hls/encryption";

export const BROWSER_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // Blob URLs become unreliable above this.

function asOutputContainer(c: Container): OutputContainer {
  if (c === "mp4" || c === "webm" || c === "mkv") return c;
  return "mp4";
}

function pickVariant(descriptor: StreamDescriptor, choice: UserChoice): Variant | null {
  if (descriptor.variants.length === 0) return null;
  if (choice.variantId) {
    for (const v of descriptor.variants) if (v.id === choice.variantId) return v;
  }
  // Highest height first, then highest bandwidth.
  const sorted = [...descriptor.variants].sort((a, b) => {
    const h = (b.height ?? 0) - (a.height ?? 0);
    if (h !== 0) return h;
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  });
  return sorted[0] ?? null;
}

function estimateSize(variant: Variant | null): number | null {
  if (!variant) return null;
  if (variant.estimatedSize != null) return variant.estimatedSize;
  return null;
}

function tooLargeForBrowser(estimated: number | null): boolean {
  return estimated != null && estimated >= BROWSER_OUTPUT_LIMIT_BYTES;
}

function resolveOutputContainer(descriptor: StreamDescriptor, choice: UserChoice): OutputContainer {
  void choice;
  return asOutputContainer(descriptor.container);
}

function audioRenditionsOf(descriptor: StreamDescriptor): readonly Variant[] {
  return descriptor.audioRenditions ?? [];
}

function hlsEncryptionFor(descriptor: StreamDescriptor): { kind: "clear" | "encrypted" | "drm-blocked"; encryption: HlsEncryption | null } {
  // Encryption may be carried on the variant segment-ref or surfaced via
  // descriptor.drm. We only reach this branch when descriptor.drm is null
  // (otherwise dispatch returns refuse before us).
  for (const v of [...descriptor.variants, ...audioRenditionsOf(descriptor)]) {
    if (v.segmentRef.kind === "hls-segments" && v.segmentRef.encryption) {
      const enc = v.segmentRef.encryption;
      const verdict = interpretHlsEncryption({ method: enc.method, uri: enc.keyUri, iv: enc.iv });
      if (verdict.treatedAs === "decryptable" && verdict.encryption) {
        return { kind: "encrypted", encryption: verdict.encryption };
      }
      if (verdict.treatedAs === "drm-blocked") {
        return { kind: "drm-blocked", encryption: null };
      }
    }
  }
  return { kind: "clear", encryption: null };
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
      return { initUrl: ref.initSegmentUrl, segmentUrls: ref.segmentUrls };
    case "dash-segments":
      if (ref.mediaUrls.length === 0) return null;
      return { initUrl: ref.initUrl || null, segmentUrls: ref.mediaUrls };
    case "byte-range":
      return null;
  }
}

function buildAvMergePlan(video: Variant, audio: Variant, choice: UserChoice): AvMergePlan | null {
  const videoTrack = mergeTrackFrom(video.segmentRef);
  const audioTrack = mergeTrackFrom(audio.segmentRef);
  if (!videoTrack || !audioTrack) return null;
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

function pickHlsAudioRendition(
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

  // Direct download: progressive + Original mode + actual direct URL.
  if (descriptor.capabilities.directDownload && choice.outputMode === "Original") {
    const direct = buildDirectPlan(descriptor, choice);
    if (direct) return direct;
  }

  const outputContainer = resolveOutputContainer(descriptor, choice);

  // HLS: classify per-variant encryption to pick plain vs AES vs blocked.
  if (descriptor.protocol === "hls") {
    const variant = pickVariant(descriptor, choice);
    if (!variant) {
      return { kind: "refuse", reason: "no_usable_variant" };
    }
    const demuxed = variant.audioRenditionId !== null;
    const audio = demuxed ? pickHlsAudioRendition(descriptor, variant, choice) : null;
    const estimated = demuxed ? combinedEstimate(variant, audio) : estimateSize(variant);
    if (tooLargeForBrowser(estimated)) {
      return { kind: "refuse", reason: "output_too_large_for_browser" };
    }
    const enc = hlsEncryptionFor(descriptor);
    if (enc.kind === "drm-blocked") {
      return { kind: "refuse", reason: "cdm_required" };
    }
    if (enc.kind === "encrypted") {
      return { kind: "refuse", reason: "hls_encryption_unsupported" };
    }
    if (demuxed) {
      // A demuxed variant must never fall back to hls-plain — that would save
      // a silent video-only file. Until both tracks carry materialized segment
      // URLs (the caller fetches the media playlists first), refuse.
      const plan = audio ? buildAvMergePlan(variant, audio, choice) : null;
      return plan ?? { kind: "refuse", reason: "no_usable_variant" };
    }
    return buildHlsPlainPlan(descriptor, choice, variant, outputContainer);
  }

  // DASH: clear demuxed video+audio merges into one MP4; anything less
  // (no audio AdaptationSet, unmaterialized or byte-range segments, or a
  // dynamic/live MPD — parseDash leaves those unmaterialized) keeps the
  // historical refusal. DRM was already refused at the top.
  if (descriptor.protocol === "dash") {
    const variant = pickVariant(descriptor, choice);
    if (!variant) {
      return { kind: "refuse", reason: "no_usable_variant" };
    }
    const audio = pickDashAudioRendition(descriptor, choice);
    const plan = audio ? buildAvMergePlan(variant, audio, choice) : null;
    if (!plan) {
      return { kind: "refuse", reason: "dash_unsupported" };
    }
    if (tooLargeForBrowser(plan.estimatedBytes)) {
      return { kind: "refuse", reason: "output_too_large_for_browser" };
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
