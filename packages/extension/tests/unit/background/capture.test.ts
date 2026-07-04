import { describe, expect, it, vi } from "vitest";
import {
  createCaptureHandler,
  demuxedPairDescriptor,
  type CaptureFetchResponse,
  type CaptureMessage,
} from "../../../src/background/capture";
import { MAIN_BRIDGE_TAG } from "../../../src/types/messages";
import { directDescriptor, hlsDescriptor } from "../popup/helpers/descriptors";
import { dispatch } from "@savemedia/core";
import type { StreamDescriptor, UserChoice } from "@savemedia/core";

const VIDEO_URL = "https://rr3---sn-example.googlevideo.com/videoplayback?id=o-AAA&itag=137&mime=video%2Fmp4";
const AUDIO_URL = "https://rr3---sn-example.googlevideo.com/videoplayback?id=o-AAA&itag=140&mime=audio%2Fmp4";

// Minimal MP4: size box + "ftyp" + brand "mp42" → magic-byte confirmed.
const FTYP_HEAD = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
]);

function response(
  contentType: string,
  body: Uint8Array | string,
  extraHeaders: Readonly<Record<string, string>> = {},
): CaptureFetchResponse {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    headers: {
      forEach: cb => {
        cb(contentType, "content-type");
        for (const [k, v] of Object.entries(extraHeaders)) cb(v, k);
      },
    },
    text: async () => (typeof body === "string" ? body : ""),
    clone: () => ({ arrayBuffer: async () => buffer }),
  };
}

const bestChoice: UserChoice = {
  outputMode: "Original",
  filename: "clip.mp4",
  variantId: null,
  audioRenditionId: null,
};

function captureMsg(url: string, audioUrl?: string): CaptureMessage {
  return {
    type: "capture",
    payload: {
      [MAIN_BRIDGE_TAG]: true,
      kind: "media-source",
      url,
      pageUrl: "https://www.youtube.com/watch?v=aQb2eDW4kzA",
      ...(audioUrl === undefined ? {} : { audioUrl }),
    },
  };
}

function harness(fetchImpl: () => Promise<CaptureFetchResponse>) {
  const fetchFn = vi.fn(fetchImpl);
  const onDescriptor = vi.fn<[number, StreamDescriptor], void>();
  const handle = createCaptureHandler({ fetchFn, onDescriptor });
  return { fetchFn, onDescriptor, handle };
}

describe("capture handler — demuxed pairs", () => {
  it("reshapes an audio-carrying capture into a dash pair descriptor", async () => {
    const { fetchFn, onDescriptor, handle } = harness(async () => response("video/mp4", FTYP_HEAD));

    await handle(7, captureMsg(VIDEO_URL, AUDIO_URL));

    expect(onDescriptor).toHaveBeenCalledTimes(1);
    const [tabId, d] = onDescriptor.mock.calls[0]!;
    expect(tabId).toBe(7);
    expect(d.protocol).toBe("dash");
    expect(d.source).toEqual({ kind: "direct-url", url: VIDEO_URL, headers: { "content-type": "video/mp4" } });
    // Video variant + linked audio rendition, each a single-URL progressive
    // MergeTrack (no init segment) — the shape dispatch turns into av-merge.
    expect(d.variants).toHaveLength(1);
    expect(d.variants[0]!.segmentRef).toEqual({ kind: "dash-segments", initUrl: "", mediaUrls: [VIDEO_URL] });
    expect(d.audioRenditions).toHaveLength(1);
    expect(d.audioRenditions![0]!.segmentRef).toEqual({ kind: "dash-segments", initUrl: "", mediaUrls: [AUDIO_URL] });
    expect(d.variants[0]!.audioRenditionId).not.toBeNull();
    expect(d.variants[0]!.audioRenditionId).toBe(d.audioRenditions![0]!.audioRenditionId);
    // The video-only half must never ship alone as a silent direct download.
    expect(d.capabilities.directDownload).toBe(false);
    // No declared total on the probe response → size stays unknown.
    expect(d.variants[0]!.estimatedSize).toBeNull();
    // The classification probe is range-limited: no full-body pull in the SW.
    expect(fetchFn).toHaveBeenCalledWith(
      VIDEO_URL,
      expect.objectContaining({ headers: { range: "bytes=0-4095" } }),
    );
  });

  it("carries the probe's content-range total so dispatch refuses an over-limit pair up front", async () => {
    const total = 5 * 1024 ** 3; // past the 2 GiB browser-output limit
    const { onDescriptor, handle } = harness(async () =>
      response("video/mp4", FTYP_HEAD, { "content-range": `bytes 0-4095/${total}` }));

    await handle(7, captureMsg(VIDEO_URL, AUDIO_URL));

    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.variants[0]!.estimatedSize).toBe(total);
    // The pair must be refused before fetching, not buffered until OOM.
    expect(dispatch(d, bestChoice)).toEqual({ kind: "refuse", reason: "output_too_large_for_browser" });
  });

  it("falls back to content-length when the server ignores the range probe", async () => {
    const { onDescriptor, handle } = harness(async () =>
      response("video/mp4", FTYP_HEAD, { "content-length": "123456789" }));

    await handle(7, captureMsg(VIDEO_URL, AUDIO_URL));

    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.variants[0]!.estimatedSize).toBe(123456789);
  });

  it("leaves plain progressive captures on the direct path", async () => {
    const { fetchFn, onDescriptor, handle } = harness(async () => response("video/mp4", FTYP_HEAD));

    await handle(1, captureMsg("https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/high.mp4"));

    expect(onDescriptor).toHaveBeenCalledTimes(1);
    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.protocol).toBe("progressive-http");
    expect(d.source.kind).toBe("direct-url");
    expect(d.capabilities.directDownload).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), { credentials: "include" });
  });

  it("drops a pair whose video half cannot be confirmed (expired/unreachable)", async () => {
    const { onDescriptor, handle } = harness(async () => {
      throw new Error("net::ERR_FAILED");
    });

    await handle(1, captureMsg(VIDEO_URL, AUDIO_URL));

    expect(onDescriptor).not.toHaveBeenCalled();
  });

  it("still drops non-media captures", async () => {
    const { onDescriptor, handle } = harness(async () => response("text/html", "<html>nope</html>"));

    await handle(1, captureMsg("https://example.com/page"));

    expect(onDescriptor).not.toHaveBeenCalled();
  });
});

describe("demuxedPairDescriptor", () => {
  it("returns non-direct descriptors unchanged", () => {
    const hls = hlsDescriptor();
    expect(demuxedPairDescriptor(hls, AUDIO_URL, null)).toBe(hls);
  });

  it("keeps identity fields while re-protocoling a direct descriptor", () => {
    const direct = directDescriptor();
    const pair = demuxedPairDescriptor(direct, AUDIO_URL, null);
    expect(pair.id).toBe(direct.id);
    expect(pair.pageUrl).toBe(direct.pageUrl);
    expect(pair.container).toBe(direct.container);
    expect(pair.protocol).toBe("dash");
    expect(pair.capabilities).toEqual({ directDownload: false, remuxableTo: [], drmBlocked: false });
  });

  it("puts the probed video size on the video half only", () => {
    const pair = demuxedPairDescriptor(directDescriptor(), AUDIO_URL, 123456789);
    expect(pair.variants[0]!.estimatedSize).toBe(123456789);
    expect(pair.audioRenditions![0]!.estimatedSize).toBeNull();
  });
});
