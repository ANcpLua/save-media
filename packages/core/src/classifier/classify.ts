import type {
  StreamDescriptor,
  StreamId,
  ProtocolFamily,
  Container,
  Confidence,
  ConfidenceLevel,
  OutputCapabilities,
  DrmStatus,
  OutputContainer,
  Presentation,
  StreamSource,
} from "../types/stream";
import type { CodecSet, HlsEncryption, SegmentRef, Variant } from "../types/codec";
import { classifyByUrl } from "./layer-url";
import { classifyByHeaders } from "./layer-headers";
import { classifyByMagicBytes } from "./layer-magic-bytes";
import { parseHlsMaster, parseHlsMediaPlaylist } from "../parser/hls/adapter";
import { hlsEncryptionOf, hlsKeyDrm, planHlsKeys } from "../parser/hls/keys";
import { parseDash } from "../parser/dash/adapter";
import { checkManifestSize } from "../parser/limits";
import { isJobError } from "../errors/taxonomy";

export interface ClassifyInput {
  readonly tabId: number;
  readonly pageUrl: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBytes: Uint8Array | null;
  readonly manifestText: string | null;
  /** Base for relative playlist references after a redirect. The source keeps its entry URL. */
  readonly manifestBaseUrl?: string;
  /**
   * The kind of file the caller found `bodyBytes` to be, when it read more
   * than the brand in the first box. A fragmented MP4 under a DASH or CMAF
   * brand whose movie box is followed by media is one playable MP4 file, not
   * a segment: its brand alone does not say which.
   */
  readonly fileContainer?: OutputContainer;
}

let _idCounter = 0;

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  guessed: 0,
  probable: 1,
  confirmed: 2,
};

function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  return {
    protocol:
      CONFIDENCE_RANK[a.protocol] >= CONFIDENCE_RANK[b.protocol]
        ? a.protocol
        : b.protocol,
    container:
      CONFIDENCE_RANK[a.container] >= CONFIDENCE_RANK[b.container]
        ? a.container
        : b.container,
    codecs:
      CONFIDENCE_RANK[a.codecs] >= CONFIDENCE_RANK[b.codecs]
        ? a.codecs
        : b.codecs,
  };
}

// Direct-download containers are standalone files, not manifests.
const PROGRESSIVE_CONTAINERS = new Set<Container>(["mp4", "mov", "webm", "mkv", "mpegts"]);

function resolveProtocol(
  fromLayers: ProtocolFamily,
  container: Container,
  confidence: Confidence,
): ProtocolFamily {
  if (fromLayers !== "unknown") return fromLayers;
  if (PROGRESSIVE_CONTAINERS.has(container) && confidence.container !== "guessed") {
    return "progressive-http";
  }
  return "unknown";
}

function remuxableTargets(container: Container): readonly ("mp4" | "webm" | "mkv")[] {
  if (
    container === "mp4" ||
    container === "fmp4" ||
    container === "cmaf" ||
    container === "mpegts"
  )
    return ["mp4"];
  if (container === "webm") return ["webm", "mp4"];
  if (container === "mkv") return ["mp4", "mkv"];
  return [];
}

function computeCapabilities(
  protocol: ProtocolFamily,
  container: Container,
  confidence: Confidence,
  _variants: readonly Variant[],
  drm: DrmStatus,
): OutputCapabilities {
  const protectedMedia = drm !== null;
  return {
    directDownload:
      !protectedMedia
      && protocol === "progressive-http"
      && PROGRESSIVE_CONTAINERS.has(container)
      && confidence.container !== "guessed",
    remuxableTo: protectedMedia || protocol !== "hls" ? [] : remuxableTargets(container),
  };
}

function buildSource(
  url: string,
  protocol: ProtocolFamily,
  headers: Readonly<Record<string, string>>,
  hlsManifestType: "master" | "media" = "master",
): StreamSource {
  if (protocol === "hls")
    return { kind: "hls-manifest", manifestUrl: url, type: hlsManifestType };
  if (protocol === "dash") return { kind: "dash-manifest", manifestUrl: url };
  return { kind: "direct-url", url, headers };
}

function hlsContainerFromSegments(segmentRef: SegmentRef): Container {
  if (segmentRef.kind !== "hls-segments") return "unknown";
  if (segmentRef.initSegmentUrl) return "fmp4";
  const first = segmentRef.segmentUrls[0] ?? "";
  if (/\.(ts|mpegts)(\?|#|$)/i.test(first)) return "mpegts";
  if (/\.(m4s|mp4|m4v)(\?|#|$)/i.test(first)) return "fmp4";
  return "unknown";
}

function mediaPlaylistVariant(
  url: string,
  media: ReturnType<typeof parseHlsMediaPlaylist>,
  encryption: HlsEncryption | null,
): Variant {
  return {
    id: `${url}#media` as Variant["id"],
    width: null,
    height: null,
    frameRate: null,
    bitrate: null,
    estimatedSize: null,
    videoCodec: null,
    audioCodec: null,
    audioRenditionId: null,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: url,
      initSegmentUrl: media.initSegmentUrl,
      segmentUrls: media.segments.map(s => s.uri),
      encryption,
    },
  };
}

export async function classify(input: ClassifyInput): Promise<StreamDescriptor> {
  const l1 = classifyByUrl(input.url);
  const l2 = classifyByHeaders(input.headers);

  // Pick the more-confident signal for each dimension.
  let protocol: ProtocolFamily =
    l2.protocol !== "unknown" ? l2.protocol : l1.protocol;
  let container: Container =
    l2.container !== "unknown" ? l2.container : l1.container;
  let confidence = mergeConfidence(l1.confidence, l2.confidence);
  const title: string | null = l2.titleHint;
  let variants: Variant[] = [];
  let audioRenditions: Variant[] = [];
  let drm: DrmStatus = null;
  const codecs: CodecSet = { video: null, audio: null, subtitles: [] };
  let hlsManifestType: "master" | "media" = "master";
  let presentation: Presentation | undefined;

  // Layer 3: manifest parse
  const manifestBase = input.manifestBaseUrl ?? input.url;
  if ((protocol === "hls" || protocol === "dash") && input.manifestText) checkManifestSize(protocol, input.manifestText, input.url);
  if (protocol === "hls" && input.manifestText) {
    const r = parseHlsMaster(input.manifestText, manifestBase);
    variants = [...r.variants];
    audioRenditions = [...r.audioRenditions];
    confidence = { ...confidence, protocol: "confirmed" };

    // A master declares its keys up front in EXT-X-SESSION-KEY; a media
    // playlist (no variant playlists) declares them in EXT-X-KEY. Both are
    // judged by planHlsKeys, over every declaration, not just the first.
    drm = hlsKeyDrm(planHlsKeys(r.sessionKeys));
    if (variants.length === 0) {
      try {
        const media = parseHlsMediaPlaylist(input.manifestText, manifestBase);
        const keys = planHlsKeys(media.keyDeclarations);
        drm = hlsKeyDrm(keys);
        hlsManifestType = "media";
        // A playlist without EXT-X-ENDLIST is still being written, EVENT playlists included.
        const longest = media.segments.reduce((most, segment) => Math.max(most, segment.duration || 0), 0);
        presentation = {
          live: !media.isVod,
          durationSeconds: media.segments.reduce((sum, segment) => sum + (segment.duration || 0), 0),
          maxSegmentSeconds: media.targetDuration ?? (longest > 0 ? longest : null),
        };
        const variant = mediaPlaylistVariant(input.url, media, keys.kind === "aes-128" ? hlsEncryptionOf(media.keyDeclarations) : null);
        variants = [variant];
        container = hlsContainerFromSegments(variant.segmentRef);
        if (container !== "unknown") {
          confidence = { ...confidence, container: "probable" };
        }
      } catch (error) {
        // A playlist that resolves to more than is read is refused, not skipped.
        if (isJobError(error)) throw error;
        // Not a media playlist; skip.
      }
    }
  } else if (protocol === "dash" && input.manifestText) {
    const r = parseDash(input.manifestText, manifestBase);
    variants = [...r.videoVariants];
    audioRenditions = [...r.audioRenditions];
    drm = r.drm;
    presentation = r.presentation;
    confidence = { ...confidence, protocol: "confirmed" };
  }

  // Layer 4: magic-byte sniff
  if (input.bodyBytes && input.bodyBytes.length > 0) {
    const l4 = classifyByMagicBytes(input.bodyBytes);
    if (l4.container !== "unknown") {
      container = input.fileContainer ?? l4.container;
      confidence = mergeConfidence(confidence, l4.confidence);
    }
  }

  // Layer 5 (init-segment probe) is invoked separately by the caller after
  // they fetch the init segment.

  // Resolve protocol after all layers so magic-bytes can inform the decision.
  protocol = resolveProtocol(protocol, container, confidence);

  const capabilities = computeCapabilities(protocol, container, confidence, variants, drm);
  const id = `stream-${++_idCounter}` as StreamId;

  return {
    id,
    tabId: input.tabId,
    pageUrl: input.pageUrl,
    title,
    detectedAt: Date.now(),
    source: buildSource(input.url, protocol, input.headers, hlsManifestType),
    protocol,
    container,
    codecs,
    variants,
    audioRenditions,
    drm,
    capabilities,
    confidence,
    ...(presentation ? { presentation } : {}),
  };
}
