import { describe, expect, it } from "vitest";
import { dispatch } from "../../src/engine/dispatch";
import type { StreamDescriptor, StreamId } from "../../src/types/stream";
import type { UserChoice } from "../../src/types/job";
import type { Variant, VariantId, AudioRenditionId, HlsEncryption } from "../../src/types/codec";

function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "v-1080" as VariantId,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 5_000_000,
    estimatedSize: 50_000_000,
    videoCodec: { rfc6381: "avc1.640028", family: "h264", profile: "High", level: "4.0" },
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 44100 },
    audioRenditionId: null,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: "https://x/master.m3u8",
      initSegmentUrl: null,
      segmentUrls: [],
      encryption: null,
    },
    ...overrides,
  };
}

function makeDirect(): StreamDescriptor {
  return {
    id: "s1" as StreamId,
    tabId: 1,
    pageUrl: "https://x",
    title: "v",
    detectedAt: 0,
    source: { kind: "direct-url", url: "https://x/v.mp4", headers: {} },
    protocol: "progressive-http",
    container: "mp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [],
    drm: null,
    capabilities: {
      directDownload: true,
      remuxableTo: ["mp4"],
      drmBlocked: false,
    },
    confidence: { protocol: "confirmed", container: "confirmed", codecs: "guessed" },
  };
}

function makeHls(encryption: HlsEncryption | null = null): StreamDescriptor {
  return {
    id: "s-hls" as StreamId,
    tabId: 1,
    pageUrl: "https://x/index.html",
    title: "hls clip",
    detectedAt: 0,
    source: { kind: "hls-manifest", manifestUrl: "https://x/master.m3u8", type: "master" },
    protocol: "hls",
    container: "mpegts",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [
      variant({
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://x/v1080.m3u8",
          initSegmentUrl: null,
          segmentUrls: [],
          encryption,
        },
      }),
    ],
    drm: null,
    capabilities: {
      directDownload: false,
      remuxableTo: ["mp4"],
      drmBlocked: false,
    },
    confidence: { protocol: "confirmed", container: "probable", codecs: "probable" },
  };
}

function makeDash(): StreamDescriptor {
  return {
    id: "s-dash" as StreamId,
    tabId: 1,
    pageUrl: "https://x/index.html",
    title: "dash clip",
    detectedAt: 0,
    source: { kind: "dash-manifest", manifestUrl: "https://x/clip.mpd" },
    protocol: "dash",
    container: "fmp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [variant({ id: "dash-1080" as VariantId, segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] } })],
    drm: null,
    capabilities: {
      directDownload: false,
      remuxableTo: ["mp4"],
      drmBlocked: false,
    },
    confidence: { protocol: "confirmed", container: "probable", codecs: "probable" },
  };
}

const AUDIO_EN = "aud1:English" as AudioRenditionId;
const AUDIO_FR = "aud1:French" as AudioRenditionId;

function hlsAudioRendition(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "a-en" as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: 128_000,
    estimatedSize: 4_000_000,
    videoCodec: null,
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 44100 },
    audioRenditionId: AUDIO_EN,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: "https://x/audio-en.m3u8",
      initSegmentUrl: "https://x/audio-init.mp4",
      segmentUrls: ["https://x/a1.m4s", "https://x/a2.m4s"],
      encryption: null,
    },
    ...overrides,
  };
}

function makeDemuxedHls(overrides: Partial<StreamDescriptor> = {}): StreamDescriptor {
  return {
    ...makeHls(),
    container: "fmp4",
    variants: [
      variant({
        audioRenditionId: AUDIO_EN,
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://x/v1080.m3u8",
          initSegmentUrl: "https://x/v-init.mp4",
          segmentUrls: ["https://x/v1.m4s", "https://x/v2.m4s"],
          encryption: null,
        },
      }),
    ],
    audioRenditions: [hlsAudioRendition()],
    ...overrides,
  };
}

function dashAudioRendition(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "dash-audio" as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: 128_000,
    estimatedSize: 9_600_000,
    videoCodec: null,
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 48000 },
    audioRenditionId: "audio" as AudioRenditionId,
    segmentRef: {
      kind: "dash-segments",
      initUrl: "https://x/init-audio.m4s",
      mediaUrls: ["https://x/a-1.m4s", "https://x/a-2.m4s"],
    },
    ...overrides,
  };
}

function makeDashAv(overrides: Partial<StreamDescriptor> = {}): StreamDescriptor {
  return {
    ...makeDash(),
    variants: [
      variant({
        id: "dash-1080" as VariantId,
        segmentRef: {
          kind: "dash-segments",
          initUrl: "https://x/init-1080.m4s",
          mediaUrls: ["https://x/v-1.m4s", "https://x/v-2.m4s"],
        },
      }),
    ],
    audioRenditions: [dashAudioRendition()],
    ...overrides,
  };
}

const originalChoice: UserChoice = {
  outputMode: "Original",
  filename: "v.mp4",
  variantId: null,
  audioRenditionId: null,
};

describe("dispatch — DRM refusal", () => {
  it("returns DispatchRefusal for any descriptor.drm value", () => {
    const d = makeDirect();
    const blocked: StreamDescriptor = {
      ...d,
      drm: { reason: "cdm_required", detectedVia: ["eme-hook"], keySystem: "com.widevine.alpha" },
      capabilities: { ...d.capabilities, drmBlocked: true },
    };
    const r = dispatch(blocked, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("cdm_required");
  });

  it("ClearKey returns clearkey_deferred reason distinct from CDM-block", () => {
    const d = { ...makeDash(), drm: { reason: "clearkey_deferred" as const, detectedVia: ["dash-content-protection" as const, "clearkey-detector" as const], keySystem: "org.w3.clearkey" }, capabilities: { ...makeDash().capabilities, drmBlocked: true } };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("clearkey_deferred");
  });
});

describe("dispatch — direct", () => {
  it("progressive + Original + direct-url → DirectPlan", () => {
    const r = dispatch(makeDirect(), originalChoice);
    expect(r.kind).toBe("direct");
    if (r.kind === "direct") {
      expect(r.url).toBe("https://x/v.mp4");
      expect(r.filename).toBe("v.mp4");
    }
  });

  it("HLS does not produce a direct plan even when capabilities allow it", () => {
    const d = { ...makeHls(), capabilities: { ...makeHls().capabilities, directDownload: true } };
    const r = dispatch(d, originalChoice);
    expect(r.kind).not.toBe("direct");
  });
});

describe("dispatch — HLS", () => {
  it("clear HLS → hls-plain plan with chosen variant", () => {
    const r = dispatch(makeHls(), { ...originalChoice, variantId: "v-1080" as VariantId });
    expect(r.kind).toBe("hls-plain");
    if (r.kind === "hls-plain") {
      expect(r.variantId).toBe("v-1080");
      expect(r.outputContainer).toBe("mp4");
      expect(r.steps.find(s => s.op === "remux")).toBeDefined();
      expect(r.steps.find(s => s.op === "verify")).toBeDefined();
      expect(r.steps.find(s => s.op === "finalize")).toBeDefined();
    }
  });

  it("AES-128 HLS → refuses instead of producing a decrypt plan", () => {
    const enc: HlsEncryption = { method: "AES-128", keyUri: "https://x/key.bin", iv: null };
    const d = makeHls(enc);
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "hls_encryption_unsupported" });
  });

  it("SAMPLE-AES HLS variant → refuses with cdm_required", () => {
    const enc = { method: "SAMPLE-AES", keyUri: "https://x/k", iv: null } as HlsEncryption;
    const d = makeHls(enc);
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("cdm_required");
  });

  it("HLS with no variants → refuses with no_usable_variant", () => {
    const d = { ...makeHls(), variants: [] };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("no_usable_variant");
  });

  it("HLS estimatedSize above 2 GiB refuses before risking a corrupt browser Blob", () => {
    const base = makeHls();
    const huge: StreamDescriptor = {
      ...base,
      variants: [variant({ estimatedSize: 3 * 1024 * 1024 * 1024 })],
    };
    const r = dispatch(huge, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "output_too_large_for_browser" });
  });
});

describe("dispatch — demuxed HLS (av-merge)", () => {
  it("variant with a linked audio rendition → av-merge plan with both tracks", () => {
    const r = dispatch(makeDemuxedHls(), originalChoice);
    expect(r.kind).toBe("av-merge");
    if (r.kind !== "av-merge") return;
    expect(r.video).toEqual({
      initUrl: "https://x/v-init.mp4",
      segmentUrls: ["https://x/v1.m4s", "https://x/v2.m4s"],
    });
    expect(r.audio).toEqual({
      initUrl: "https://x/audio-init.mp4",
      segmentUrls: ["https://x/a1.m4s", "https://x/a2.m4s"],
    });
    expect(r.outputContainer).toBe("mp4");
    expect(r.outputFilename).toBe("v.mp4");
    expect(r.estimatedBytes).toBe(54_000_000); // 50 MB video + 4 MB audio
  });

  it("muxed variant (audioRenditionId null) stays hls-plain even with renditions present", () => {
    const d = makeDemuxedHls({ variants: [variant()] });
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("hls-plain");
  });

  it("demuxed variant with unmaterialized segment URLs refuses instead of saving video-only", () => {
    // Default variant() segmentRef has segmentUrls: [] — the media playlists
    // have not been fetched yet.
    const d = makeDemuxedHls({ variants: [variant({ audioRenditionId: AUDIO_EN })] });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "no_usable_variant" });
  });

  it("demuxed variant whose rendition is missing from the descriptor refuses", () => {
    const d = makeDemuxedHls({ audioRenditions: [] });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "no_usable_variant" });
  });

  it("choice.audioRenditionId overrides the variant's linked rendition", () => {
    const fr = hlsAudioRendition({
      id: "a-fr" as VariantId,
      audioRenditionId: AUDIO_FR,
      segmentRef: {
        kind: "hls-segments",
        playlistUrl: "https://x/audio-fr.m3u8",
        initSegmentUrl: "https://x/audio-fr-init.mp4",
        segmentUrls: ["https://x/fr1.m4s"],
        encryption: null,
      },
    });
    const d = makeDemuxedHls({ audioRenditions: [hlsAudioRendition(), fr] });
    const r = dispatch(d, { ...originalChoice, audioRenditionId: AUDIO_FR });
    expect(r.kind).toBe("av-merge");
    if (r.kind !== "av-merge") return;
    expect(r.audio.segmentUrls).toEqual(["https://x/fr1.m4s"]);
  });

  it("AES-128 on the audio rendition still refuses encrypted HLS", () => {
    const enc: HlsEncryption = { method: "AES-128", keyUri: "https://x/key.bin", iv: null };
    const d = makeDemuxedHls({
      audioRenditions: [
        hlsAudioRendition({
          segmentRef: {
            kind: "hls-segments",
            playlistUrl: "https://x/audio-en.m3u8",
            initSegmentUrl: "https://x/audio-init.mp4",
            segmentUrls: ["https://x/a1.m4s"],
            encryption: enc,
          },
        }),
      ],
    });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "hls_encryption_unsupported" });
  });

  it("SAMPLE-AES on the audio rendition refuses with cdm_required", () => {
    const enc = { method: "SAMPLE-AES", keyUri: "https://x/k", iv: null } as HlsEncryption;
    const d = makeDemuxedHls({
      audioRenditions: [
        hlsAudioRendition({
          segmentRef: {
            kind: "hls-segments",
            playlistUrl: "https://x/audio-en.m3u8",
            initSegmentUrl: "https://x/audio-init.mp4",
            segmentUrls: ["https://x/a1.m4s"],
            encryption: enc,
          },
        }),
      ],
    });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "cdm_required" });
  });

  it("size cap sums both tracks: each under 2 GiB but combined over → refuses", () => {
    const d = makeDemuxedHls({
      variants: [
        variant({
          audioRenditionId: AUDIO_EN,
          estimatedSize: 1_610_612_736, // 1.5 GiB
          segmentRef: {
            kind: "hls-segments",
            playlistUrl: "https://x/v1080.m3u8",
            initSegmentUrl: "https://x/v-init.mp4",
            segmentUrls: ["https://x/v1.m4s"],
            encryption: null,
          },
        }),
      ],
      audioRenditions: [hlsAudioRendition({ estimatedSize: 644_245_094 })], // 0.6 GiB
    });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "output_too_large_for_browser" });
  });
});

describe("dispatch — DASH", () => {
  it("clear DASH with video + audio tracks → av-merge plan", () => {
    const r = dispatch(makeDashAv(), { ...originalChoice, variantId: "dash-1080" as VariantId });
    expect(r.kind).toBe("av-merge");
    if (r.kind !== "av-merge") return;
    expect(r.video).toEqual({
      initUrl: "https://x/init-1080.m4s",
      segmentUrls: ["https://x/v-1.m4s", "https://x/v-2.m4s"],
    });
    expect(r.audio).toEqual({
      initUrl: "https://x/init-audio.m4s",
      segmentUrls: ["https://x/a-1.m4s", "https://x/a-2.m4s"],
    });
    expect(r.outputContainer).toBe("mp4");
    expect(r.estimatedBytes).toBe(59_600_000); // 50 MB video + 9.6 MB audio
  });

  it("clear DASH without an audio rendition still refuses dash_unsupported", () => {
    const r = dispatch(makeDash(), { ...originalChoice, variantId: "dash-1080" as VariantId });
    expect(r).toEqual({ kind: "refuse", reason: "dash_unsupported" });
  });

  it("audio rendition with no materialized media URLs refuses dash_unsupported", () => {
    const d = makeDashAv({
      audioRenditions: [
        dashAudioRendition({ segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] } }),
      ],
    });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "dash_unsupported" });
  });

  it("video variant with no materialized media URLs refuses dash_unsupported", () => {
    const d = makeDashAv({
      variants: [
        variant({
          id: "dash-1080" as VariantId,
          segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [] },
        }),
      ],
    });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "dash_unsupported" });
  });

  it("DASH with no variants refuses with no_usable_variant", () => {
    const d = makeDashAv({ variants: [] });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "no_usable_variant" });
  });

  it("empty dash-segments initUrl maps to a null MergeTrack initUrl", () => {
    const d = makeDashAv({
      variants: [
        variant({
          id: "dash-1080" as VariantId,
          segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: ["https://x/v-1.m4s"] },
        }),
      ],
    });
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("av-merge");
    if (r.kind !== "av-merge") return;
    expect(r.video.initUrl).toBeNull();
  });

  it("picks the highest-bitrate audio rendition when the choice names none", () => {
    const lo = dashAudioRendition({
      id: "dash-audio-lo" as VariantId,
      audioRenditionId: "audio-lo" as AudioRenditionId,
      bitrate: 96_000,
      segmentRef: { kind: "dash-segments", initUrl: "https://x/init-audio-lo.m4s", mediaUrls: ["https://x/lo-1.m4s"] },
    });
    const d = makeDashAv({ audioRenditions: [lo, dashAudioRendition()] });
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("av-merge");
    if (r.kind !== "av-merge") return;
    expect(r.audio.initUrl).toBe("https://x/init-audio.m4s");
  });

  it("choice.audioRenditionId selects the named DASH rendition", () => {
    const lo = dashAudioRendition({
      id: "dash-audio-lo" as VariantId,
      audioRenditionId: "audio-lo" as AudioRenditionId,
      bitrate: 96_000,
      segmentRef: { kind: "dash-segments", initUrl: "https://x/init-audio-lo.m4s", mediaUrls: ["https://x/lo-1.m4s"] },
    });
    const d = makeDashAv({ audioRenditions: [lo, dashAudioRendition()] });
    const r = dispatch(d, { ...originalChoice, audioRenditionId: "audio-lo" as AudioRenditionId });
    expect(r.kind).toBe("av-merge");
    if (r.kind !== "av-merge") return;
    expect(r.audio.segmentUrls).toEqual(["https://x/lo-1.m4s"]);
  });

  it("size cap sums both DASH tracks before emitting a plan", () => {
    const d = makeDashAv({
      variants: [
        variant({
          id: "dash-1080" as VariantId,
          estimatedSize: 1_610_612_736, // 1.5 GiB
          segmentRef: { kind: "dash-segments", initUrl: "https://x/init-1080.m4s", mediaUrls: ["https://x/v-1.m4s"] },
        }),
      ],
      audioRenditions: [dashAudioRendition({ estimatedSize: 644_245_094 })], // 0.6 GiB
    });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "output_too_large_for_browser" });
  });
});

describe("dispatch — progressive containers", () => {
  it("progressive WebM + Original mode (output stays webm) → direct plan", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "webm",
      source: { kind: "direct-url", url: "https://x/v.webm", headers: {} },
      capabilities: {
        directDownload: true,
        remuxableTo: ["webm", "mp4"],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("direct");
  });

  it("progressive MKV + Original mode → direct plan", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "mkv",
      source: { kind: "direct-url", url: "https://x/v.mkv", headers: {} },
      capabilities: {
        directDownload: true,
        remuxableTo: ["mp4", "mkv"],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r.kind).toBe("direct");
  });

  it("progressive direct-url without direct-download capability refuses instead of inventing a conversion", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      container: "mp4",
      source: { kind: "direct-url", url: "https://x/v.mp4", headers: {} },
      capabilities: {
        directDownload: false,
        remuxableTo: [],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "unsupported_output" });
  });

  it("unknown protocol direct-url refuses instead of best-effort downloading", () => {
    const d: StreamDescriptor = {
      ...makeDirect(),
      protocol: "unknown",
      confidence: { protocol: "guessed", container: "guessed", codecs: "guessed" },
      capabilities: {
        directDownload: false,
        remuxableTo: [],
        drmBlocked: false,
      },
    };
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "unsupported_output" });
  });
});

describe("dispatch — variant selection", () => {
  it("prefers the explicitly chosen variantId when present", () => {
    const d: StreamDescriptor = {
      ...makeHls(),
      variants: [
        variant({ id: "v-720" as VariantId, height: 720 }),
        variant({ id: "v-1080" as VariantId, height: 1080 }),
      ],
    };
    const r = dispatch(d, { ...originalChoice, variantId: "v-720" as VariantId });
    if (r.kind !== "hls-plain") throw new Error("expected hls-plain");
    expect(r.variantId).toBe("v-720");
  });

  it("falls back to highest height when no variantId is selected", () => {
    const d: StreamDescriptor = {
      ...makeHls(),
      variants: [
        variant({ id: "v-720" as VariantId, height: 720, bitrate: 3_000_000 }),
        variant({ id: "v-1080" as VariantId, height: 1080, bitrate: 5_000_000 }),
      ],
    };
    const r = dispatch(d, originalChoice);
    if (r.kind !== "hls-plain") throw new Error("expected hls-plain");
    expect(r.variantId).toBe("v-1080");
  });
});

describe("dispatch — MP4 codec gate (av-merge)", () => {
  const vp9 = { rfc6381: "vp09.00.10.08", family: "vp9" as const, profile: null, level: null };
  const av1 = { rfc6381: "av01.0.04M.08", family: "av1" as const, profile: null, level: null };
  const opus = { rfc6381: "opus", family: "opus" as const, channels: 2, sampleRate: 48000 };

  it("demuxed HLS with a VP9 variant refuses instead of failing late in the muxer", () => {
    const d = makeDemuxedHls();
    const demuxedRef = d.variants[0]!.segmentRef;
    const r = dispatch(
      makeDemuxedHls({ variants: [variant({ audioRenditionId: AUDIO_EN, segmentRef: demuxedRef, videoCodec: vp9 })] }),
      originalChoice,
    );
    expect(r).toEqual({ kind: "refuse", reason: "no_usable_variant" });
  });

  it("clear DASH with an Opus audio rendition refuses dash_unsupported", () => {
    const d = makeDashAv({ audioRenditions: [dashAudioRendition({ audioCodec: opus })] });
    const r = dispatch(d, originalChoice);
    expect(r).toEqual({ kind: "refuse", reason: "dash_unsupported" });
  });

  it("falls back to the variant's CODECS audio declaration when the rendition carries none", () => {
    const d = makeDemuxedHls();
    const demuxedRef = d.variants[0]!.segmentRef;
    const r = dispatch(
      makeDemuxedHls({
        variants: [variant({ audioRenditionId: AUDIO_EN, segmentRef: demuxedRef, audioCodec: opus })],
        audioRenditions: [hlsAudioRendition({ audioCodec: null })],
      }),
      originalChoice,
    );
    expect(r).toEqual({ kind: "refuse", reason: "no_usable_variant" });
  });

  it("AV1 + AAC still merges — MP4 carries both natively", () => {
    const d = makeDashAv();
    const r = dispatch(
      makeDashAv({ variants: [{ ...d.variants[0]!, videoCodec: av1 }] }),
      { ...originalChoice, variantId: d.variants[0]!.id },
    );
    expect(r.kind).toBe("av-merge");
  });

  it("null codecs pass — a magic-byte-confirmed progressive pair carries no declaration", () => {
    const d = makeDashAv();
    const r = dispatch(
      makeDashAv({
        variants: [{ ...d.variants[0]!, videoCodec: null, audioCodec: null }],
        audioRenditions: [dashAudioRendition({ audioCodec: null })],
      }),
      { ...originalChoice, variantId: d.variants[0]!.id },
    );
    expect(r.kind).toBe("av-merge");
  });
});
