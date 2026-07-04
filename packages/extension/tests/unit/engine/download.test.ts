import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadJob } from "../../../src/engine/download";
import { runAvMergeJob } from "../../../src/engine/jobs/av-merge";
import { directDescriptor, hlsDescriptor, dashDescriptor, drmDescriptor, clearKeyDescriptor } from "../popup/helpers/descriptors";
import type { AudioRenditionId, UserChoice, Variant, VariantId } from "@savemedia/core";

vi.mock("../../../src/engine/jobs/av-merge", () => ({
  runAvMergeJob: vi.fn(),
}));

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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
});

describe("engine downloadJob — integrates dispatch with job runners", () => {
  it("direct progressive + Original → runDirectJob branch (Blob URL)", async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]) as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const result = await downloadJob(directDescriptor(), baseChoice, vi.fn(), new AbortController().signal);
    expect(result.filename).toBe("clip.mp4");
    expect(result.blobUrl).toBe("blob:integration");
  });

  it("DRM-blocked descriptor → throws encrypted_media_detected/cdm_required", async () => {
    const d = drmDescriptor("cdm_required");
    await expect(downloadJob(d, baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "cdm_required" });
  });

  it("ClearKey-deferred descriptor → throws clearkey_deferred", async () => {
    await expect(downloadJob(clearKeyDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "clearkey_deferred" });
  });

  it("DASH descriptor → throws dash_unsupported", async () => {
    await expect(downloadJob(dashDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "dash_unsupported" });
  });

  it("HLS descriptor + unsupported segment bytes → surfaces the HLS refusal", async () => {
    const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST\n`;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith(".m3u8")) return new Response(playlist, { status: 200 });
      if (u.endsWith("seg1.ts")) return new Response(new Uint8Array([0x01, 0x02]) as BodyInit, { status: 200 });
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    await expect(downloadJob(hlsDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
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
  it("DASH with an audio rendition → runAvMergeJob gets the plan, progress fn, and signal", async () => {
    const onProgress = vi.fn();
    const signal = new AbortController().signal;

    const result = await downloadJob(
      dashDescriptor({ audioRenditions: [dashAudioRendition()] }),
      baseChoice,
      onProgress,
      signal,
    );

    expect(result.blobUrl).toBe("blob:av-merge");
    expect(runAvMergeJob).toHaveBeenCalledWith(
      {
        kind: "av-merge",
        video: {
          initUrl: "https://example.com/dash/init.m4s",
          segmentUrls: ["https://example.com/dash/seg001.m4s"],
        },
        audio: {
          initUrl: "https://example.com/dash/audio-init.m4s",
          segmentUrls: ["https://example.com/dash/audio-seg001.m4s"],
        },
        outputContainer: "mp4",
        outputFilename: "clip.mp4",
        estimatedBytes: 102_000_000,
      },
      onProgress,
      signal,
    );
  });

  it("demuxed HLS → both media playlists materialize into concrete merge tracks", async () => {
    patchPlaylistFetch({
      "https://example.com/v1080.m3u8": VIDEO_MEDIA_PLAYLIST,
      "https://example.com/a-eng.m3u8": AUDIO_MEDIA_PLAYLIST,
    });
    const onProgress = vi.fn();
    const signal = new AbortController().signal;

    const result = await downloadJob(demuxedHlsDescriptor(), baseChoice, onProgress, signal);

    expect(result.blobUrl).toBe("blob:av-merge");
    expect(onProgress).toHaveBeenCalledWith(0, null, "fetching-playlist");
    expect(runAvMergeJob).toHaveBeenCalledWith(
      {
        kind: "av-merge",
        video: {
          initUrl: "https://example.com/v-init.mp4",
          segmentUrls: ["https://example.com/v-seg1.m4s", "https://example.com/v-seg2.m4s"],
        },
        audio: {
          initUrl: "https://example.com/a-init.mp4",
          segmentUrls: ["https://example.com/a-seg1.m4s"],
        },
        outputContainer: "mp4",
        outputFilename: "clip.mp4",
        // Recomputed at materialization from BANDWIDTH × playlist duration
        // (5 Mb/s × 8 s + 128 kb/s × 4 s), overriding the stale master-level
        // estimates — this is what feeds dispatch's browser-output guard.
        estimatedBytes: 5_064_000,
      },
      onProgress,
      signal,
    );
  });

  it("demuxed HLS with a live audio playlist → hls_live_unsupported", async () => {
    patchPlaylistFetch({
      "https://example.com/v1080.m3u8": VIDEO_MEDIA_PLAYLIST,
      "https://example.com/a-eng.m3u8": LIVE_AUDIO_PLAYLIST,
    });

    await expect(downloadJob(demuxedHlsDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "hls_live_unsupported", manifestUrl: "https://example.com/a-eng.m3u8" });
    expect(runAvMergeJob).not.toHaveBeenCalled();
  });

  it("demuxed HLS with an AES-128 audio playlist → hls_encryption_unsupported refusal", async () => {
    patchPlaylistFetch({
      "https://example.com/v1080.m3u8": VIDEO_MEDIA_PLAYLIST,
      "https://example.com/a-eng.m3u8": AES_AUDIO_PLAYLIST,
    });

    await expect(downloadJob(demuxedHlsDescriptor(), baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "hls_encryption_unsupported" });
    expect(runAvMergeJob).not.toHaveBeenCalled();
  });

  it("demuxed HLS with no matching rendition → refuses instead of a video-only file", async () => {
    const noRenditions = { ...demuxedHlsDescriptor(), audioRenditions: [] };
    globalThis.fetch = vi.fn(async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;

    await expect(downloadJob(noRenditions, baseChoice, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "manifest_malformed" });
    expect(runAvMergeJob).not.toHaveBeenCalled();
  });
});
