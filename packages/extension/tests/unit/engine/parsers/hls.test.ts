import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { materializeDemuxedHls } from "../../../../src/engine/parsers/hls";
import { hlsDescriptor, dashDescriptor, drmDescriptor } from "../../popup/helpers/descriptors";
import { dispatch } from "@savemedia/core";
import type { AudioRenditionId, StreamDescriptor, UserChoice, Variant, VariantId } from "@savemedia/core";

const RENDITION_EN = "audio:eng" as AudioRenditionId;
const RENDITION_DE = "audio:deu" as AudioRenditionId;

const baseChoice: UserChoice = {
  outputMode: "Original",
  filename: "clip.mp4",
  variantId: null,
  audioRenditionId: null,
};

function videoVariant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "v-1080" as VariantId,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 5_000_000,
    estimatedSize: 100_000_000,
    videoCodec: { rfc6381: "avc1.640028", family: "h264", profile: "High", level: "4.0" },
    audioCodec: null,
    audioRenditionId: RENDITION_EN,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: "https://example.com/v1080.m3u8",
      initSegmentUrl: null,
      segmentUrls: [],
      encryption: null,
    },
    ...overrides,
  };
}

function audioRendition(overrides: Partial<Variant> = {}): Variant {
  return {
    id: "a-eng" as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: 128_000,
    estimatedSize: 4_000_000,
    videoCodec: null,
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 44100 },
    audioRenditionId: RENDITION_EN,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: "https://example.com/a-eng.m3u8",
      initSegmentUrl: null,
      segmentUrls: [],
      encryption: null,
    },
    ...overrides,
  };
}

function demuxedDescriptor(overrides: Partial<StreamDescriptor> = {}): StreamDescriptor {
  return hlsDescriptor({
    variants: [videoVariant()],
    audioRenditions: [audioRendition()],
    ...overrides,
  });
}

const VIDEO_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="v-init.mp4"
#EXTINF:4.0,
v-seg1.m4s
#EXTINF:4.0,
v-seg2.m4s
#EXT-X-ENDLIST
`;

const AUDIO_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="a-init.mp4"
#EXTINF:4.0,
a-seg1.m4s
#EXT-X-ENDLIST
`;

const LIVE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg1.m4s
`;

const AES_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4.0,
a-seg1.ts
#EXT-X-ENDLIST
`;

const SAMPLE_AES_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://x/license"
#EXTINF:4.0,
a-seg1.ts
#EXT-X-ENDLIST
`;

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function patchFetch(byUrl: Readonly<Record<string, string | Response>>) {
  const mock = vi.fn(async (url: RequestInfo | URL) => {
    const entry = byUrl[String(url)];
    if (entry === undefined) throw new Error(`unexpected ${String(url)}`);
    return typeof entry === "string" ? new Response(entry, { status: 200 }) : entry;
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function refuseFetch() {
  const mock = vi.fn(async () => { throw new Error("should not fetch"); });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function hlsRef(v: Variant | undefined) {
  if (!v || v.segmentRef.kind !== "hls-segments") throw new Error("expected hls-segments ref");
  return v.segmentRef;
}

describe("materializeDemuxedHls — passthrough", () => {
  it("returns non-HLS descriptors unchanged without fetching", async () => {
    const fetchMock = refuseFetch();
    const d = dashDescriptor();
    const out = await materializeDemuxedHls(d, baseChoice, vi.fn(), new AbortController().signal);
    expect(out).toBe(d);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns muxed HLS (no linked audio rendition) unchanged without fetching", async () => {
    const fetchMock = refuseFetch();
    const d = hlsDescriptor();
    const out = await materializeDemuxedHls(d, baseChoice, vi.fn(), new AbortController().signal);
    expect(out).toBe(d);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns DRM-flagged descriptors unchanged without fetching", async () => {
    const fetchMock = refuseFetch();
    const d = drmDescriptor();
    const out = await materializeDemuxedHls(d, baseChoice, vi.fn(), new AbortController().signal);
    expect(out).toBe(d);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a demuxed descriptor unchanged when no rendition matches the variant link", async () => {
    const fetchMock = refuseFetch();
    const d = demuxedDescriptor({ audioRenditions: [] });
    const out = await materializeDemuxedHls(d, baseChoice, vi.fn(), new AbortController().signal);
    expect(out).toBe(d);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the descriptor unchanged when both tracks already carry segment URLs", async () => {
    const fetchMock = refuseFetch();
    const d = demuxedDescriptor({
      variants: [videoVariant({
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://example.com/v1080.m3u8",
          initSegmentUrl: "https://example.com/v-init.mp4",
          segmentUrls: ["https://example.com/v-seg1.m4s"],
          encryption: null,
        },
      })],
      audioRenditions: [audioRendition({
        segmentRef: {
          kind: "hls-segments",
          playlistUrl: "https://example.com/a-eng.m3u8",
          initSegmentUrl: "https://example.com/a-init.mp4",
          segmentUrls: ["https://example.com/a-seg1.m4s"],
          encryption: null,
        },
      })],
    });
    const out = await materializeDemuxedHls(d, baseChoice, vi.fn(), new AbortController().signal);
    expect(out).toBe(d);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("materializeDemuxedHls — materialization", () => {
  it("fetches both media playlists and rebuilds init + absolutized segment URLs", async () => {
    const fetchMock = patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": AUDIO_PLAYLIST,
    });
    const onProgress = vi.fn();
    const d = demuxedDescriptor();

    const out = await materializeDemuxedHls(d, baseChoice, onProgress, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(0, null, "fetching-playlist");

    const video = hlsRef(out.variants[0]);
    expect(video.initSegmentUrl).toBe("https://example.com/v-init.mp4");
    expect(video.segmentUrls).toEqual([
      "https://example.com/v-seg1.m4s",
      "https://example.com/v-seg2.m4s",
    ]);
    expect(video.encryption).toBeNull();

    const audio = hlsRef(out.audioRenditions?.[0]);
    expect(audio.initSegmentUrl).toBe("https://example.com/a-init.mp4");
    expect(audio.segmentUrls).toEqual(["https://example.com/a-seg1.m4s"]);

    // BANDWIDTH × summed playlist duration feeds dispatch's size guard.
    expect(out.variants[0]!.estimatedSize).toBe(5_000_000); // 5 Mb/s × 8 s
    expect(out.audioRenditions![0]!.estimatedSize).toBe(64_000); // 128 kb/s × 4 s

    // The input descriptor is not mutated.
    expect(hlsRef(d.variants[0]).segmentUrls).toEqual([]);
    expect(hlsRef(d.audioRenditions?.[0]).segmentUrls).toEqual([]);
  });

  it("fills estimatedSize so dispatch refuses an over-limit demuxed stream before fetching segments", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": AUDIO_PLAYLIST,
    });
    // 8 s of segments at this BANDWIDTH crosses the 2 GiB browser limit.
    const d = demuxedDescriptor({
      variants: [videoVariant({ bitrate: 2_200_000_000, estimatedSize: null })],
      audioRenditions: [audioRendition({ bitrate: null, estimatedSize: null })],
    });

    const out = await materializeDemuxedHls(d, baseChoice, vi.fn(), new AbortController().signal);

    expect(out.variants[0]!.estimatedSize).toBe(2_200_000_000);
    // No BANDWIDTH on the EXT-X-MEDIA rendition — its size stays unknown.
    expect(out.audioRenditions![0]!.estimatedSize).toBeNull();
    expect(dispatch(out, baseChoice)).toEqual({ kind: "refuse", reason: "output_too_large_for_browser" });
  });

  it("materializes the explicitly chosen variant and rendition, leaving others untouched", async () => {
    const lowVariant = videoVariant({
      id: "v-720" as VariantId,
      height: 720,
      segmentRef: {
        kind: "hls-segments",
        playlistUrl: "https://example.com/v720.m3u8",
        initSegmentUrl: null,
        segmentUrls: [],
        encryption: null,
      },
    });
    const germanRendition = audioRendition({
      id: "a-deu" as VariantId,
      audioRenditionId: RENDITION_DE,
      segmentRef: {
        kind: "hls-segments",
        playlistUrl: "https://example.com/a-deu.m3u8",
        initSegmentUrl: null,
        segmentUrls: [],
        encryption: null,
      },
    });
    const fetchMock = patchFetch({
      "https://example.com/v720.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-deu.m3u8": AUDIO_PLAYLIST,
    });
    const d = demuxedDescriptor({
      variants: [videoVariant(), lowVariant],
      audioRenditions: [audioRendition(), germanRendition],
    });
    const choice: UserChoice = {
      ...baseChoice,
      variantId: "v-720" as VariantId,
      audioRenditionId: RENDITION_DE,
    };

    const out = await materializeDemuxedHls(d, choice, vi.fn(), new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hlsRef(out.variants[0]).segmentUrls).toEqual([]); // 1080p untouched
    expect(hlsRef(out.variants[1]).segmentUrls.length).toBe(2);
    expect(hlsRef(out.audioRenditions?.[0]).segmentUrls).toEqual([]); // english untouched
    expect(hlsRef(out.audioRenditions?.[1]).segmentUrls).toEqual(["https://example.com/a-seg1.m4s"]);
  });

  it("defaults to the highest-resolution variant, mirroring dispatch", async () => {
    const lowVariant = videoVariant({
      id: "v-720" as VariantId,
      height: 720,
      segmentRef: {
        kind: "hls-segments",
        playlistUrl: "https://example.com/v720.m3u8",
        initSegmentUrl: null,
        segmentUrls: [],
        encryption: null,
      },
    });
    patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": AUDIO_PLAYLIST,
    });
    const d = demuxedDescriptor({ variants: [lowVariant, videoVariant()] });

    const out = await materializeDemuxedHls(d, baseChoice, vi.fn(), new AbortController().signal);

    expect(hlsRef(out.variants[0]).segmentUrls).toEqual([]); // 720p untouched
    expect(hlsRef(out.variants[1]).segmentUrls.length).toBe(2);
  });

  it("attaches AES-128 runtime encryption so dispatch can refuse", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": AES_PLAYLIST,
    });

    const out = await materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal);

    expect(hlsRef(out.audioRenditions?.[0]).encryption).toMatchObject({
      method: "AES-128",
      keyUri: "https://example.com/key.bin",
    });
  });

  it("attaches SAMPLE-AES runtime encryption so dispatch can refuse", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": SAMPLE_AES_PLAYLIST,
    });

    const out = await materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal);

    expect(hlsRef(out.audioRenditions?.[0]).encryption).toMatchObject({ method: "SAMPLE-AES" });
  });
});

describe("materializeDemuxedHls — failures", () => {
  it("throws hls_live_unsupported for a live media playlist", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": LIVE_PLAYLIST,
    });

    await expect(materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({
        code: "hls_live_unsupported",
        severity: "terminal",
        manifestUrl: "https://example.com/v1080.m3u8",
      });
  });

  it("classifies a denied playlist fetch as access_denied", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": new Response("nope", { status: 403 }),
    });

    await expect(materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({
        code: "access_denied",
        phase: "manifest",
        url: "https://example.com/a-eng.m3u8",
      });
  });
});
