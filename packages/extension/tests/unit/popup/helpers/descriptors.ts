import type {
  StreamDescriptor,
  StreamId,
  DrmReason,
  VariantId,
  Variant,
} from "@savemedia/core";

export function directDescriptor(
  overrides: Partial<StreamDescriptor> & { title?: string | null } = {},
): StreamDescriptor {
  return {
    id: "stream-direct" as StreamId,
    tabId: 1,
    pageUrl: "https://example.com/page",
    title: overrides.title ?? "clip name",
    detectedAt: 1700000000000,
    source: { kind: "direct-url", url: "https://example.com/clip.mp4", headers: {} },
    protocol: "progressive-http",
    container: "mp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [],
    drm: null,
    capabilities: {
      directDownload: true,
      remuxableTo: ["mp4"],
    },
    confidence: { protocol: "probable", container: "probable", codecs: "guessed" },
    ...overrides,
  };
}

export function hlsDescriptor(
  overrides: Partial<StreamDescriptor> = {},
): StreamDescriptor {
  const variant: Variant = {
    id: "v-1080" as VariantId,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 5_000_000,
    estimatedSize: 100_000_000,
    videoCodec: { rfc6381: "avc1.640028", family: "h264", profile: "High", level: "4.0" },
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 44100 },
    audioRenditionId: null,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: "https://example.com/master.m3u8",
      initSegmentUrl: null,
      segmentUrls: [],
      encryption: null,
    },
  };
  return {
    id: "stream-hls" as StreamId,
    tabId: 1,
    pageUrl: "https://example.com/page",
    title: "master.m3u8",
    detectedAt: 1700000000000,
    source: { kind: "hls-manifest", manifestUrl: "https://example.com/master.m3u8", type: "master" },
    protocol: "hls",
    container: "mpegts",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [variant],
    drm: null,
    capabilities: {
      directDownload: false,
      remuxableTo: ["mp4"],
    },
    confidence: { protocol: "confirmed", container: "probable", codecs: "probable" },
    ...overrides,
  };
}

/**
 * A clear DASH row the browser engine cannot assemble: its segments are byte
 * ranges of one file, so the manifest gives no address to fetch one by one.
 * This, a manifest still being written and a codec the MP4 muxer does not
 * write are what dash_unsupported is left for.
 */
export function unassemblableDash(overrides: Partial<StreamDescriptor> = {}): StreamDescriptor {
  const row = dashDescriptor();
  return dashDescriptor({
    variants: row.variants.map(variant => ({ ...variant, segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] } })),
    ...overrides,
  });
}

/** A clear DASH row with no audio declared: `dashDescriptor()`. It is saved with its picture alone. */
export function dashDescriptor(
  overrides: Partial<StreamDescriptor> = {},
): StreamDescriptor {
  const variant: Variant = {
    id: "dash-1080" as VariantId,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 5_000_000,
    estimatedSize: 100_000_000,
    videoCodec: { rfc6381: "avc1.640028", family: "h264", profile: "High", level: "4.0" },
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 44100 },
    audioRenditionId: null,
    segmentRef: {
      kind: "dash-segments",
      initUrl: "https://example.com/dash/init.m4s",
      mediaUrls: ["https://example.com/dash/seg001.m4s"],
    },
  };
  return {
    id: "stream-dash" as StreamId,
    tabId: 1,
    pageUrl: "https://example.com/page",
    title: "clip.mpd",
    detectedAt: 1700000000000,
    source: { kind: "dash-manifest", manifestUrl: "https://example.com/dash/clip.mpd" },
    protocol: "dash",
    container: "fmp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [variant],
    drm: null,
    capabilities: {
      directDownload: false,
      remuxableTo: [],
    },
    confidence: { protocol: "confirmed", container: "probable", codecs: "probable" },
    ...overrides,
  };
}

export function drmDescriptor(reason: DrmReason = "cdm_required"): StreamDescriptor {
  return {
    ...hlsDescriptor(),
    id: `stream-${reason}` as StreamId,
    drm: {
      reason,
      detectedVia: ["dash-content-protection"],
      keySystem: "com.widevine.alpha",
    },
    capabilities: {
      directDownload: false,
      remuxableTo: [],
    },
  };
}

export function clearKeyDescriptor(): StreamDescriptor {
  return drmDescriptor("clearkey_deferred");
}
