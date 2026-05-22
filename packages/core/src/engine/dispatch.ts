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
  OutputMode,
  DirectPlan,
  HlsPlainPlan,
  HlsAesPlan,
  DashPlan,
  RemuxPlan,
  TranscodePlan,
} from "../types/job";
import type { Variant, HlsEncryption } from "../types/codec";
import { interpretHlsEncryption } from "../parser/hls/encryption";

const NATIVE_SINK_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

const OUTPUT_CONTAINER_FOR_MODE: Record<OutputMode, OutputContainer | null> = {
  "Original": null,
  "MP4 Compatible": "mp4",
  "Best Quality": "mp4",
  "Small File": "mp4",
  "Manual": null,
};

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

function useNativeSinkFor(estimated: number | null): boolean {
  return estimated != null && estimated >= NATIVE_SINK_THRESHOLD_BYTES;
}

function resolveOutputContainer(descriptor: StreamDescriptor, choice: UserChoice): OutputContainer {
  const requested = OUTPUT_CONTAINER_FOR_MODE[choice.outputMode];
  if (requested) return requested;
  return asOutputContainer(descriptor.container);
}

function hlsEncryptionFor(descriptor: StreamDescriptor): { kind: "clear" | "aes-128" | "drm-blocked"; encryption: HlsEncryption | null } {
  // Encryption may be carried on the variant segment-ref or surfaced via
  // descriptor.drm. We only reach this branch when descriptor.drm is null
  // (otherwise dispatch returns refuse before us).
  for (const v of descriptor.variants) {
    if (v.segmentRef.kind === "hls-segments" && v.segmentRef.encryption) {
      const enc = v.segmentRef.encryption;
      const verdict = interpretHlsEncryption({ method: enc.method, uri: enc.keyUri, iv: enc.iv });
      if (verdict.treatedAs === "decryptable" && verdict.encryption) {
        return { kind: "aes-128", encryption: verdict.encryption };
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
    { op: "fetch-init-segment", url: "" },
    { op: "remux", engine: "mediabunny", toContainer: outputContainer },
    { op: "verify", checks: ["segment-count", "container-validity"] },
    { op: "finalize", sink: useNativeSinkFor(estimatedBytes) ? "native-streaming-sink" : "downloads" },
  ];
  return {
    kind: "hls-plain",
    steps,
    outputContainer,
    outputFilename: choice.filename,
    variantId: variant.id,
    estimatedBytes,
    useNativeSink: useNativeSinkFor(estimatedBytes),
  };
}

function buildHlsAesPlan(
  _descriptor: StreamDescriptor,
  choice: UserChoice,
  variant: Variant,
  outputContainer: OutputContainer,
  encryption: HlsEncryption,
): HlsAesPlan {
  const estimatedBytes = estimateSize(variant);
  const steps: JobStep[] = [
    { op: "fetch-key", url: encryption.keyUri },
    { op: "decrypt-aes-128", segmentIndex: 0, keyHandle: encryption.keyUri as unknown as Parameters<(k: import("../types/job").KeyHandle) => void>[0] },
    { op: "remux", engine: "mediabunny", toContainer: outputContainer },
    { op: "verify", checks: ["segment-count", "container-validity"] },
    { op: "finalize", sink: useNativeSinkFor(estimatedBytes) ? "native-streaming-sink" : "downloads" },
  ];
  return {
    kind: "hls-aes",
    steps,
    outputContainer,
    outputFilename: choice.filename,
    variantId: variant.id,
    estimatedBytes,
    useNativeSink: useNativeSinkFor(estimatedBytes),
    keyUri: encryption.keyUri,
    encryption,
  };
}

function buildDashPlan(
  _descriptor: StreamDescriptor,
  choice: UserChoice,
  variant: Variant,
  outputContainer: OutputContainer,
): DashPlan {
  const estimatedBytes = estimateSize(variant);
  const steps: JobStep[] = [
    { op: "fetch-init-segment", url: "" },
    { op: "remux", engine: "mediabunny", toContainer: outputContainer },
    { op: "verify", checks: ["segment-count", "container-validity"] },
    { op: "finalize", sink: useNativeSinkFor(estimatedBytes) ? "native-streaming-sink" : "downloads" },
  ];
  return {
    kind: "dash",
    steps,
    outputContainer,
    outputFilename: choice.filename,
    variantId: variant.id,
    audioRenditionId: choice.audioRenditionId,
    estimatedBytes,
    useNativeSink: useNativeSinkFor(estimatedBytes),
  };
}

function buildRemuxPlan(
  descriptor: StreamDescriptor,
  choice: UserChoice,
  outputContainer: OutputContainer,
): RemuxPlan {
  const steps: JobStep[] = [
    { op: "remux", engine: "mediabunny", toContainer: outputContainer },
    { op: "verify", checks: ["container-validity"] },
    { op: "finalize", sink: "downloads" },
  ];
  return {
    kind: "remux",
    steps,
    fromContainer: asOutputContainer(descriptor.container),
    outputContainer,
    outputFilename: choice.filename,
    estimatedBytes: null,
  };
}

function buildTranscodePlan(
  descriptor: StreamDescriptor,
  choice: UserChoice,
  outputContainer: OutputContainer,
): TranscodePlan {
  // Pick a target H.264 baseline for MP4 Compatible / Small File.
  const fromVideoCodec = descriptor.codecs.video ?? {
    rfc6381: "unknown",
    family: "unknown",
    profile: null,
    level: null,
  };
  const toVideoCodec = {
    rfc6381: "avc1.42E01E",
    family: "h264" as const,
    profile: "Baseline",
    level: "3.0",
  };
  const steps: JobStep[] = [
    { op: "transcode", engine: "ffmpeg-wasm", from: fromVideoCodec, to: toVideoCodec },
    { op: "verify", checks: ["container-validity"] },
    { op: "finalize", sink: "downloads" },
  ];
  return {
    kind: "transcode",
    steps,
    outputContainer,
    outputFilename: choice.filename,
    fromVideoCodec,
    toVideoCodec,
    engine: "ffmpeg-wasm",
  };
}

function buildDirectPlan(descriptor: StreamDescriptor, choice: UserChoice): DirectPlan | null {
  if (descriptor.source.kind !== "direct-url") return null;
  return { kind: "direct", url: descriptor.source.url, filename: choice.filename };
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
      return { kind: "refuse", reason: "clear_segments_unavailable" };
    }
    const enc = hlsEncryptionFor(descriptor);
    if (enc.kind === "drm-blocked") {
      return { kind: "refuse", reason: "cdm_required" };
    }
    if (enc.kind === "aes-128" && enc.encryption) {
      return buildHlsAesPlan(descriptor, choice, variant, outputContainer, enc.encryption);
    }
    return buildHlsPlainPlan(descriptor, choice, variant, outputContainer);
  }

  if (descriptor.protocol === "dash") {
    const variant = pickVariant(descriptor, choice);
    if (!variant) {
      return { kind: "refuse", reason: "clear_segments_unavailable" };
    }
    return buildDashPlan(descriptor, choice, variant, outputContainer);
  }

  // Progressive: pick direct if Original (or the requested output already
  // matches the on-the-wire container), else remux/transcode based on
  // container/codec compatibility with the requested output container.
  if (descriptor.protocol === "progressive-http") {
    const direct = buildDirectPlan(descriptor, choice);
    const sourceMatchesOutput =
      (descriptor.container === "mp4" || descriptor.container === "webm" || descriptor.container === "mkv") &&
      descriptor.container === outputContainer;
    if (direct && (choice.outputMode === "Original" || sourceMatchesOutput)) {
      return direct;
    }
    if (descriptor.capabilities.remuxableTo.includes(outputContainer)) {
      return buildRemuxPlan(descriptor, choice, outputContainer);
    }
    if (descriptor.capabilities.transcodeableTo.includes(outputContainer)) {
      return buildTranscodePlan(descriptor, choice, outputContainer);
    }
    return { kind: "refuse", reason: "clear_segments_unavailable" };
  }

  // Unknown protocol with direct URL → fall through to direct as best effort.
  const direct = buildDirectPlan(descriptor, choice);
  if (direct) return direct;
  return { kind: "refuse", reason: "clear_segments_unavailable" };
}

export type { DirectPlan, HlsPlainPlan, HlsAesPlan, DashPlan, RemuxPlan, TranscodePlan };
