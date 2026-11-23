import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { materializeDemuxedHls, parseHlsMediaPlaylistRuntime, requireSupportedHlsVod } from "../../../../src/engine/parsers/hls";
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
    expect(onProgress).toHaveBeenCalledWith({ stage: { kind: "playlist" }, bytesWritten: 0, bytesTotal: null });

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

  it("fills estimatedSize from the bit rate for the progress display, and dispatch does not refuse the save on it", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": AUDIO_PLAYLIST,
    });
    // 8 s of segments at this BANDWIDTH adds up to more than the 2 GiB browser limit. BANDWIDTH is the peak
    // rate, so the sum is an estimate that leans high and no size the stream states.
    const d = demuxedDescriptor({
      variants: [videoVariant({ bitrate: 2_200_000_000, estimatedSize: null })],
      audioRenditions: [audioRendition({ bitrate: null, estimatedSize: null })],
    });

    const out = await materializeDemuxedHls(d, baseChoice, vi.fn(), new AbortController().signal);

    expect(out.variants[0]!.estimatedSize).toBe(2_200_000_000);
    // No BANDWIDTH on the EXT-X-MEDIA rendition — its size stays unknown.
    expect(out.audioRenditions![0]!.estimatedSize).toBeNull();
    expect(dispatch(out, baseChoice)).toMatchObject({ kind: "av-merge", estimatedBytes: 2_200_000_000 });
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

  it("prepares the page's Referer for both playlist hosts before requesting them", async () => {
    const fetchMock = patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": AUDIO_PLAYLIST,
    });
    const prepareRequests = vi.fn(async () => { expect(fetchMock).not.toHaveBeenCalled(); });
    await materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal, undefined, prepareRequests);
    expect(prepareRequests).toHaveBeenCalledWith(["https://example.com/v1080.m3u8", "https://example.com/a-eng.m3u8"]);
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

  it("refuses a SAMPLE-AES audio rendition at playlist validation", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": SAMPLE_AES_PLAYLIST,
    });

    await expect(materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "cdm_required", keySystem: "SAMPLE-AES" });
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

  // A page has no end tag either: before this check it was told as a live stream.
  it("says a track playlist address that sends a web page as the save starts is no playlist any more, never a live stream", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": VIDEO_PLAYLIST,
      "https://example.com/a-eng.m3u8": "<html><body>Please sign in</body></html>",
    });
    await expect(materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response: "page", host: "example.com", atSaveStart: true });
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
        // The playlist is read again as the save starts.
        atSaveStart: true,
      });
  });
});

describe("bounded playlists", () => {
  it("refuses a media playlist with more segments than a job reads, before it is parsed", async () => {
    const { parseHlsMediaPlaylistRuntime } = await import("../../../../src/engine/parsers/hls");
    const endless = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n" + "#EXTINF:1,\ns.ts\n".repeat(100_001);
    expect(() => parseHlsMediaPlaylistRuntime(endless, "https://cdn.test/v.m3u8"))
      .toThrowError(expect.objectContaining({ code: "manifest_too_large", limit: "segments" }));
  });

  it("stops reading a playlist body at the limit instead of holding all of it", async () => {
    const { readManifestText } = await import("../../../../src/engine/net/manifest-text");
    const { MAX_MANIFEST_BYTES } = await import("@savemedia/core");
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(35);
    const body = new ReadableStream<Uint8Array>({ pull(controller) { sent++; controller.enqueue(chunk); } });
    await expect(readManifestText(new Response(body), "https://cdn.test/endless.m3u8"))
      .rejects.toMatchObject({ code: "manifest_too_large", limit: "bytes" });
    expect(sent * chunk.byteLength).toBeLessThan(MAX_MANIFEST_BYTES + 4 * chunk.byteLength);
    expect(await readManifestText(new Response("#EXTM3U\n"), "https://cdn.test/a.m3u8")).toBe("#EXTM3U\n");
  });
});

describe("playlists whose parts are byte ranges", () => {
  const URL_OF = "https://example.com/v/media.m3u8";
  const playlist = (...lines: string[]) => ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:2", ...lines, "#EXT-X-ENDLIST", ""].join("\n");
  const part = (range: string, uri = "clip.mp4") => ["#EXTINF:2.0,", ...(range ? [`#EXT-X-BYTERANGE:${range}`] : []), uri];
  const HEADER = '#EXT-X-MAP:URI="clip.mp4",BYTERANGE="800@0"';
  const ranges = (text: string) => parseHlsMediaPlaylistRuntime(text, URL_OF).ranges;

  it("reads ranges that cover one file from its first byte as that file, up to where they end", () => {
    expect(ranges(playlist(HEADER, ...part("1200@800"), ...part("1000@2000")))).toEqual({ url: "https://example.com/v/clip.mp4", bytes: 3000, gaps: [] });
    // A range without an offset starts where the one before ends.
    expect(ranges(playlist(HEADER, ...part("1200@800"), ...part("1000")))).toEqual({ url: "https://example.com/v/clip.mp4", bytes: 3000, gaps: [] });
    // A transport stream has no header: the first part starts the file.
    expect(ranges(playlist(...part("1880@0", "clip.ts"), ...part("3760", "clip.ts")))).toEqual({ url: "https://example.com/v/clip.ts", bytes: 5640, gaps: [] });
  });

  // A packager's one-file output keeps the file's index between the header and the first part, and the playlist does not name it.
  it("reads a fragmented MP4's ranges that leave stretches out as that one file, and says which stretches: what they hold is checked once the file is read", () => {
    expect(ranges(playlist('#EXT-X-MAP:URI="clip.mp4",BYTERANGE="870@0"', ...part("99313@938"), ...part("5000"))))
      .toEqual({ url: "https://example.com/v/clip.mp4", bytes: 105251, gaps: [{ offset: 870, length: 68 }] });
    expect(ranges(playlist(HEADER, ...part("1200@800"), ...part("1000@2100"))))
      .toEqual({ url: "https://example.com/v/clip.mp4", bytes: 3100, gaps: [{ offset: 2000, length: 100 }] });
    const media = parseHlsMediaPlaylistRuntime(playlist(HEADER, ...part("1200@900"), ...part("1000")), URL_OF);
    expect(media.ranges).toEqual({ url: "https://example.com/v/clip.mp4", bytes: 3100, gaps: [{ offset: 800, length: 100 }] });
    expect(() => requireSupportedHlsVod(media, URL_OF)).not.toThrow();
  });

  it("says every part has its own address when no range is stated", () => {
    expect(ranges(playlist('#EXT-X-MAP:URI="init.mp4"', ...part("", "a.m4s"), ...part("", "b.m4s")))).toBe("addresses");
  });

  it.each([
    ["a gap between two parts of a transport stream", playlist(...part("1880@0", "clip.ts"), ...part("1880@2068", "clip.ts"))],
    ["a transport stream that does not start the file", playlist(...part("1880@188", "clip.ts"), ...part("1880", "clip.ts"))],
    ["parts that overlap", playlist(HEADER, ...part("1200@800"), ...part("1000@1900"))],
    ["a header that does not start the file", playlist('#EXT-X-MAP:URI="clip.mp4",BYTERANGE="700@100"', ...part("1200@800"), ...part("1000"))],
    ["a header kept in another file", playlist('#EXT-X-MAP:URI="init.mp4"', ...part("1200@0"), ...part("1000"))],
    ["a part kept in another file", playlist(HEADER, ...part("1200@800"), ...part("1000@2000", "other.mp4"))],
    ["a part with an address of its own among them", playlist(HEADER, ...part("1200@800"), ...part("", "whole.m4s"))],
    ["parts out of order", playlist(HEADER, ...part("1000@2000"), ...part("1200@800"))],
  ])("does not take ranges with %s for one file, and refuses them before anything is requested", (_name, text) => {
    const media = parseHlsMediaPlaylistRuntime(text, URL_OF);
    expect(media.ranges).toBe("scattered");
    expect(() => requireSupportedHlsVod(media, URL_OF))
      .toThrow(expect.objectContaining({ code: "hls_layout_unsupported", manifestUrl: URL_OF, layout: "byte-ranges" }));
  });

  it("refuses byte ranges that are each encrypted on their own", () => {
    const media = parseHlsMediaPlaylistRuntime(playlist('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', ...part("1888@0", "clip.ts"), ...part("1888", "clip.ts")), URL_OF);
    expect(media.ranges).toEqual({ url: "https://example.com/v/clip.ts", bytes: 3776, gaps: [] });
    expect(() => requireSupportedHlsVod(media, URL_OF)).toThrow(expect.objectContaining({ code: "hls_layout_unsupported", layout: "byte-ranges" }));
  });

  it("gives a demuxed track kept in one file to the merge as that file, with the length its ranges state", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": playlist('#EXT-X-MAP:URI="video.mp4",BYTERANGE="800@0"', ...part("1200@800", "video.mp4"), ...part("1000", "video.mp4")),
      "https://example.com/a-eng.m3u8": playlist('#EXT-X-MAP:URI="audio.mp4",BYTERANGE="600@0"', ...part("400@600", "audio.mp4")),
    });
    const out = await materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal);
    expect(dispatch(out, baseChoice)).toMatchObject({
      kind: "av-merge",
      video: { initUrl: null, segmentUrls: ["https://example.com/video.mp4"], fileBytes: 3000 },
      audio: { initUrl: null, segmentUrls: ["https://example.com/audio.mp4"], fileBytes: 1000 },
    });
    const merge = dispatch(out, baseChoice) as { video: object; audio: object };
    expect("fileGaps" in merge.video || "fileGaps" in merge.audio).toBe(false);
  });

  it("tells the merge which stretches such a track's ranges leave out, so it checks them once it has the file", async () => {
    patchFetch({
      "https://example.com/v1080.m3u8": playlist('#EXT-X-MAP:URI="video.mp4",BYTERANGE="800@0"', ...part("1200@868", "video.mp4"), ...part("1000", "video.mp4")),
      "https://example.com/a-eng.m3u8": playlist('#EXT-X-MAP:URI="audio.mp4",BYTERANGE="600@0"', ...part("400@644", "audio.mp4")),
    });
    const out = await materializeDemuxedHls(demuxedDescriptor(), baseChoice, vi.fn(), new AbortController().signal);
    expect(dispatch(out, baseChoice)).toMatchObject({
      kind: "av-merge",
      video: { segmentUrls: ["https://example.com/video.mp4"], fileBytes: 3068, fileGaps: [{ offset: 800, length: 68 }] },
      audio: { segmentUrls: ["https://example.com/audio.mp4"], fileBytes: 1044, fileGaps: [{ offset: 600, length: 44 }] },
    });
  });

  it("knows a fragmented MP4 playlist that changes its header part-way, and refuses it before anything is requested", () => {
    const changing = playlist('#EXT-X-MAP:URI="a/init.mp4"', ...part("", "a/0.m4s"), "#EXT-X-DISCONTINUITY", '#EXT-X-MAP:URI="b/init.mp4"', ...part("", "b/0.m4s"));
    const media = parseHlsMediaPlaylistRuntime(changing, URL_OF);
    expect(media.initChanges).toBe(true);
    expect(() => requireSupportedHlsVod(media, URL_OF))
      .toThrow(expect.objectContaining({ code: "hls_layout_unsupported", manifestUrl: URL_OF, layout: "init-changes" }));
    // The same header named again, one header for every part, and a transport stream with a discontinuity: one stream.
    for (const text of [changing.replace("b/init.mp4", "a/init.mp4"), playlist('#EXT-X-MAP:URI="init.mp4"', ...part("", "0.m4s"), ...part("", "1.m4s")),
      playlist(...part("", "a.ts"), "#EXT-X-DISCONTINUITY", ...part("", "b.ts"))]) {
      const one = parseHlsMediaPlaylistRuntime(text, URL_OF);
      expect(one.initChanges).toBe(false);
      expect(() => requireSupportedHlsVod(one, URL_OF)).not.toThrow();
    }
  });
});
