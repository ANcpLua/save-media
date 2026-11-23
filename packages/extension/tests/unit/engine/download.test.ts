import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadJob } from "../../../src/engine/download";
import { runAvMergeJob } from "../../../src/engine/jobs/av-merge";
import { runDirectJob } from "../../../src/engine/jobs/direct";
import { directDescriptor, hlsDescriptor, dashDescriptor, drmDescriptor, clearKeyDescriptor, unassemblableDash } from "../popup/helpers/descriptors";
import type { AudioRenditionId, UserChoice, Variant, VariantId } from "@savemedia/core";

vi.mock("../../../src/engine/jobs/av-merge", () => ({
  runAvMergeJob: vi.fn(),
}));
vi.mock("../../../src/engine/jobs/direct", () => ({ runDirectJob: vi.fn() }));

const baseChoice: UserChoice = {
  outputMode: "Original",
  filename: "clip.mp4",
  variantId: null,
  audioRenditionId: null,
};

let originalFetch: typeof fetch;
let originalCreateObjectURL: typeof URL.createObjectURL;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:integration");
  // setup.ts resets all mocks after each test, so re-arm the module mock here.
  vi.mocked(runAvMergeJob).mockResolvedValue({ blobUrl: "blob:av-merge", filename: "merged.mp4", checksum: "" });
  vi.mocked(runDirectJob).mockResolvedValue({ blobUrl: "blob:integration", filename: "clip.mp4", checksum: "" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
});

describe("engine downloadJob — integrates dispatch with job runners", () => {
  it("direct progressive + Original → runDirectJob branch (Blob URL)", async () => {
    const descriptor = directDescriptor();
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    const result = await downloadJob(descriptor, baseChoice, { onProgress, signal });
    expect(result.filename).toBe("clip.mp4");
    expect(result.blobUrl).toBe("blob:integration");
    expect(runDirectJob).toHaveBeenCalledWith({ kind: "direct", url: "https://example.com/clip.mp4", filename: "clip.mp4" },
      { onProgress, signal, tabId: descriptor.tabId, fetchFile: globalThis.fetch, resumeKey: undefined, onRetained: undefined });
  });

  it("hands a direct job its resume key and the retained-bytes report unchanged", async () => {
    const onRetained = vi.fn();
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    await downloadJob(directDescriptor(), baseChoice, { onProgress, signal, resumeKey: "named-file", onRetained });
    expect(vi.mocked(runDirectJob).mock.calls[0]?.[1]).toMatchObject({ resumeKey: "named-file", onRetained, onProgress, signal });
  });

  it("DRM-blocked descriptor → throws encrypted_media_detected/cdm_required", async () => {
    const d = drmDescriptor("cdm_required");
    await expect(downloadJob(d, baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "cdm_required" });
  });

  it("ClearKey-deferred descriptor → throws clearkey_deferred", async () => {
    await expect(downloadJob(clearKeyDescriptor(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "clearkey_deferred" });
  });

  it("DASH the engine cannot assemble → throws dash_unsupported without a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(downloadJob(unassemblableDash(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "dash_unsupported" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HLS descriptor + unsupported segment bytes → surfaces the HLS refusal", async () => {
    const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST\n`;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith(".m3u8")) return new Response(playlist, { status: 200 });
      if (u.endsWith("seg1.ts")) return new Response(new Uint8Array([0x01, 0x02]) as BodyInit, { status: 200 });
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    await expect(downloadJob(hlsDescriptor(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "hls_layout_unsupported" });
    expect(runAvMergeJob).not.toHaveBeenCalled();
  });
});

const RENDITION_ID = "audio:eng" as AudioRenditionId;

function dashAudioRendition(): Variant {
  return {
    id: "dash-audio" as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: 128_000,
    estimatedSize: 2_000_000,
    videoCodec: null,
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 44100 },
    audioRenditionId: "audio-en" as AudioRenditionId,
    segmentRef: {
      kind: "dash-segments",
      initUrl: "https://example.com/dash/audio-init.m4s",
      mediaUrls: ["https://example.com/dash/audio-seg001.m4s"],
    },
  };
}

function demuxedHlsDescriptor() {
  const video: Variant = {
    id: "v-1080" as VariantId,
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 5_000_000,
    estimatedSize: 100_000_000,
    videoCodec: { rfc6381: "avc1.640028", family: "h264", profile: "High", level: "4.0" },
    audioCodec: null,
    audioRenditionId: RENDITION_ID,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: "https://example.com/v1080.m3u8",
      initSegmentUrl: null,
      segmentUrls: [],
      encryption: null,
    },
  };
  const audio: Variant = {
    id: "a-eng" as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: 128_000,
    estimatedSize: 4_000_000,
    videoCodec: null,
    audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 44100 },
    audioRenditionId: RENDITION_ID,
    segmentRef: {
      kind: "hls-segments",
      playlistUrl: "https://example.com/a-eng.m3u8",
      initSegmentUrl: null,
      segmentUrls: [],
      encryption: null,
    },
  };
  return hlsDescriptor({ variants: [video], audioRenditions: [audio] });
}

const VIDEO_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="v-init.mp4"
#EXTINF:4.0,
v-seg1.m4s
#EXTINF:4.0,
v-seg2.m4s
#EXT-X-ENDLIST
`;

const AUDIO_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="a-init.mp4"
#EXTINF:4.0,
a-seg1.m4s
#EXT-X-ENDLIST
`;

const LIVE_AUDIO_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
a-seg1.m4s
`;

const AES_AUDIO_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-KEY:METHOD=AES-128,URI="https://x/key.bin"
#EXTINF:4.0,
a-seg1.ts
#EXT-X-ENDLIST
`;

function patchPlaylistFetch(byUrl: Readonly<Record<string, string>>): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const text = byUrl[String(url)];
    if (text === undefined) throw new Error(`unexpected ${String(url)}`);
    return new Response(text, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("engine downloadJob — av-merge routing", () => {
  const MPD = (extra = "") => `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT4S"><Period>${extra}
    <AdaptationSet contentType="video"><Representation id="1080" mimeType="video/mp4" codecs="avc1.640028" bandwidth="5000000" width="1920" height="1080">
      <SegmentTemplate duration="2" initialization="init-$RepresentationID$.m4s" media="seg-$RepresentationID$-$Number$.m4s" startNumber="1"/></Representation></AdaptationSet>
    <AdaptationSet contentType="audio" lang="en"><Representation id="aac" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="128000">
      <SegmentTemplate duration="2" initialization="init-$RepresentationID$.m4s" media="seg-$RepresentationID$-$Number$.m4s" startNumber="1"/></Representation></AdaptationSet>
  </Period></MPD>`;
  /** A listed DASH row: each track carries one sampled address, never its whole list. */
  const listedDash = () => {
    const row = dashDescriptor({ audioRenditions: [dashAudioRendition()] });
    return { ...row, variants: row.variants.map(variant => ({ ...variant, id: "https://old-node.example/dash/clip.mpd#1080" as VariantId })) };
  };

  it("DASH → the manifest is read again when the save starts, and its segments are what is fetched", async () => {
    patchPlaylistFetch({ "https://example.com/dash/clip.mpd": MPD() });
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    const prepareRequests = vi.fn(async () => undefined);

    const result = await downloadJob(listedDash(), { ...baseChoice, variantId: "https://old-node.example/dash/clip.mpd#1080" as VariantId },
      { onProgress, signal, prepareRequests });

    expect(result.blobUrl).toBe("blob:av-merge");
    expect(onProgress).toHaveBeenCalledWith({ stage: { kind: "playlist" }, bytesWritten: 0, bytesTotal: null });
    // The page's Referer is asked for the manifest's host before the manifest is requested.
    expect(prepareRequests).toHaveBeenCalledWith(["https://example.com/dash/clip.mpd"]);
    expect(vi.mocked(globalThis.fetch).mock.calls[0]![1]).toMatchObject({ credentials: "include" });
    expect(runAvMergeJob).toHaveBeenCalledWith(
      {
        kind: "av-merge",
        video: {
          initUrl: "https://example.com/dash/init-1080.m4s",
          segmentUrls: ["https://example.com/dash/seg-1080-1.m4s", "https://example.com/dash/seg-1080-2.m4s"],
        },
        audio: {
          initUrl: "https://example.com/dash/init-aac.m4s",
          segmentUrls: ["https://example.com/dash/seg-aac-1.m4s", "https://example.com/dash/seg-aac-2.m4s"],
        },
        outputContainer: "mp4",
        outputFilename: "clip.mp4",
        estimatedBytes: expect.any(Number),
      },
      { onProgress, signal, request: expect.any(Function), prepareRequests },
    );
  });

  it("DASH that declares no audio → the video track alone goes to the merge job, which saves it without sound", async () => {
    const videoOnly = MPD().replace(/<AdaptationSet contentType="audio"[\s\S]*?<\/AdaptationSet>/, "");
    expect(videoOnly).not.toContain("audio");
    patchPlaylistFetch({ "https://example.com/dash/clip.mpd": videoOnly });
    const result = await downloadJob(dashDescriptor(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal });
    expect(result.blobUrl).toBe("blob:av-merge");
    expect(vi.mocked(runAvMergeJob).mock.calls.at(-1)![0]).toMatchObject({
      kind: "av-merge",
      video: { initUrl: "https://example.com/dash/init-1080.m4s",
        segmentUrls: ["https://example.com/dash/seg-1080-1.m4s", "https://example.com/dash/seg-1080-2.m4s"] },
      audio: null,
    });
  });

  it("DASH listed without audio whose manifest names an audio track when the save starts → both tracks are merged", async () => {
    patchPlaylistFetch({ "https://example.com/dash/clip.mpd": MPD() });
    await downloadJob(dashDescriptor(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal });
    expect(vi.mocked(runAvMergeJob).mock.calls.at(-1)![0]).toMatchObject({ audio: { initUrl: "https://example.com/dash/init-aac.m4s" } });
  });

  it("DASH → a manifest that declares protection when the save starts is refused, and nothing of it is fetched", async () => {
    patchPlaylistFetch({ "https://example.com/dash/clip.mpd":
      MPD('<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>').replace("<AdaptationSet contentType=\"video\">",
        '<AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>') });
    await expect(downloadJob(listedDash(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "cdm_required" });
    expect(runAvMergeJob).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("DASH → an address that no longer answers with a manifest fails with a reason, and a refused one names the refusal", async () => {
    // A web page where the manifest was (a sign-in page, a network's block page): said as that, read again as the save started.
    patchPlaylistFetch({ "https://example.com/dash/clip.mpd": "<html><body>Please sign in</body></html>" });
    await expect(downloadJob(listedDash(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response: "page", host: "example.com", atSaveStart: true });
    patchPlaylistFetch({ "https://example.com/dash/clip.mpd": '{"error":"session ended"}' });
    await expect(downloadJob(listedDash(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response: "data", host: "example.com", atSaveStart: true });
    // A manifest that is one and cannot be read stays a damaged manifest.
    patchPlaylistFetch({ "https://example.com/dash/clip.mpd": '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>' });
    await expect(downloadJob(listedDash(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "manifest_malformed", url: "https://example.com/dash/clip.mpd" });
    globalThis.fetch = vi.fn(async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(downloadJob(listedDash(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toEqual({ code: "access_denied", severity: "terminal", phase: "manifest", url: "https://example.com/dash/clip.mpd", httpStatus: 403,
        explanation: "forbidden-or-expired-url", atSaveStart: true });
    expect(runAvMergeJob).not.toHaveBeenCalled();
  });

  it("direct → the save asks for the page's Referer on the file's host and on the host it redirects to", async () => {
    const prepareRequests = vi.fn(async () => undefined);
    const row = directDescriptor();
    const redirected = { ...row, source: { ...row.source, finalUrl: "https://node7.cdn.example/clip.mp4" } } as typeof row;
    await downloadJob(redirected, baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal, prepareRequests });
    expect(prepareRequests).toHaveBeenCalledExactlyOnceWith(["https://example.com/clip.mp4", "https://node7.cdn.example/clip.mp4"]);
    expect(prepareRequests.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(runDirectJob).mock.invocationCallOrder.at(-1)!);
  });

  it("demuxed HLS → both media playlists materialize into concrete merge tracks", async () => {
    patchPlaylistFetch({
      "https://example.com/v1080.m3u8": VIDEO_MEDIA_PLAYLIST,
      "https://example.com/a-eng.m3u8": AUDIO_MEDIA_PLAYLIST,
    });
    const onProgress = vi.fn();
    const signal = new AbortController().signal;

    const result = await downloadJob(demuxedHlsDescriptor(), baseChoice, { onProgress, signal });

    expect(result.blobUrl).toBe("blob:av-merge");
    expect(onProgress).toHaveBeenCalledWith({ stage: { kind: "playlist" }, bytesWritten: 0, bytesTotal: null });
    expect(runAvMergeJob).toHaveBeenCalledWith(
      {
        kind: "av-merge",
        video: {
          initUrl: "https://example.com/v-init.mp4",
          segmentUrls: ["https://example.com/v-seg1.m4s", "https://example.com/v-seg2.m4s"],
          segmentKeys: [null, null],
        },
        audio: {
          initUrl: "https://example.com/a-init.mp4",
          segmentUrls: ["https://example.com/a-seg1.m4s"],
          segmentKeys: [null],
        },
        outputContainer: "mp4",
        outputFilename: "clip.mp4",
        // Recomputed at materialization from BANDWIDTH × playlist duration
        // (5 Mb/s × 8 s + 128 kb/s × 4 s), overriding the stale master-level
        // estimates — this is what feeds dispatch's browser-output guard.
        estimatedBytes: 5_064_000,
      },
      { onProgress, signal, request: expect.any(Function), prepareRequests: undefined },
    );
  });

  it("demuxed HLS with a live audio playlist → hls_live_unsupported", async () => {
    patchPlaylistFetch({
      "https://example.com/v1080.m3u8": VIDEO_MEDIA_PLAYLIST,
      "https://example.com/a-eng.m3u8": LIVE_AUDIO_PLAYLIST,
    });

    await expect(downloadJob(demuxedHlsDescriptor(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "hls_live_unsupported", manifestUrl: "https://example.com/a-eng.m3u8" });
    expect(runAvMergeJob).not.toHaveBeenCalled();
  });

  it("demuxed HLS with an AES-128 audio playlist → merged, with the key of each audio segment", async () => {
    patchPlaylistFetch({
      "https://example.com/v1080.m3u8": VIDEO_MEDIA_PLAYLIST,
      "https://example.com/a-eng.m3u8": AES_AUDIO_PLAYLIST,
    });

    await downloadJob(demuxedHlsDescriptor(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal });
    expect(vi.mocked(runAvMergeJob).mock.calls[0]?.[0]).toMatchObject({
      kind: "av-merge",
      video: { segmentKeys: [null, null] },
      audio: { initUrl: null, segmentUrls: ["https://example.com/a-seg1.ts"],
        segmentKeys: [{ keyUri: "https://x/key.bin", iv: null, mediaSequence: 0 }] },
    });
  });

  it("checks a later key declaration in a separate HLS audio rendition before merging", async () => {
    const audio = AES_AUDIO_PLAYLIST.replace("#EXT-X-ENDLIST", [
      '#EXT-X-KEY:METHOD=AES-128,URI="https://x/other",KEYFORMAT="com.apple.streamingkeydelivery"',
      "#EXTINF:4.0,", "a-seg2.ts", "#EXT-X-ENDLIST",
    ].join("\n"));
    patchPlaylistFetch({
      "https://example.com/v1080.m3u8": VIDEO_MEDIA_PLAYLIST,
      "https://example.com/a-eng.m3u8": audio,
    });
    await expect(downloadJob(demuxedHlsDescriptor(), baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "cdm_required", keySystem: "com.apple.streamingkeydelivery" });
    expect(runAvMergeJob).not.toHaveBeenCalled();
  });

  it("demuxed HLS with no matching rendition → refuses instead of a video-only file", async () => {
    const noRenditions = { ...demuxedHlsDescriptor(), audioRenditions: [] };
    globalThis.fetch = vi.fn(async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;

    await expect(downloadJob(noRenditions, baseChoice, { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "manifest_malformed" });
    expect(runAvMergeJob).not.toHaveBeenCalled();
  });
});
