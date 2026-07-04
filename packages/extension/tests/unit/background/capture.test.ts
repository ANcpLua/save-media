import { describe, expect, it, vi } from "vitest";
import {
  createCaptureHandler,
  demuxedPairDescriptor,
  type CaptureDeps,
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
  stream?: ReadableStream<Uint8Array>,
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
    ...(stream === undefined ? {} : { body: stream }),
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

function harness(fetchImpl: CaptureDeps["fetchFn"]) {
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
    expect(demuxedPairDescriptor(hls, AUDIO_URL, null, null)).toBe(hls);
  });

  it("keeps identity fields while re-protocoling a direct descriptor", () => {
    const direct = directDescriptor();
    const pair = demuxedPairDescriptor(direct, AUDIO_URL, null, null);
    expect(pair.id).toBe(direct.id);
    expect(pair.pageUrl).toBe(direct.pageUrl);
    expect(pair.container).toBe(direct.container);
    expect(pair.protocol).toBe("dash");
    expect(pair.capabilities).toEqual({ directDownload: false, remuxableTo: [], drmBlocked: false });
  });

  it("puts each probed size on its own half", () => {
    const pair = demuxedPairDescriptor(directDescriptor(), AUDIO_URL, 123456789, 9876543);
    expect(pair.variants[0]!.estimatedSize).toBe(123456789);
    expect(pair.audioRenditions![0]!.estimatedSize).toBe(9876543);
  });

  it("leaves an unprobeable half's size unknown rather than wrong", () => {
    const pair = demuxedPairDescriptor(directDescriptor(), AUDIO_URL, 123456789, null);
    expect(pair.audioRenditions![0]!.estimatedSize).toBeNull();
  });
});

describe("capture handler — probe safety", () => {
  it("reads at most 4 KiB from a stream even when the server ignores the range header", async () => {
    let pulls = 0;
    let cancelled = false;
    const firstChunk = new Uint8Array(1024);
    firstChunk.set(FTYP_HEAD);
    // An endless 200 body standing in for a multi-GB file on a server that
    // ignored the range header: every pull yields another KiB forever.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(pulls === 1 ? firstChunk : new Uint8Array(1024));
      },
      cancel() { cancelled = true; },
    });
    const { onDescriptor, handle } = harness(async () =>
      response("video/mp4", FTYP_HEAD, { "content-length": "5368709120" }, endless));

    await handle(7, captureMsg(VIDEO_URL, AUDIO_URL));

    // Classification still worked from the streamed head…
    expect(onDescriptor).toHaveBeenCalledTimes(1);
    expect(onDescriptor.mock.calls[0]![1].protocol).toBe("dash");
    // …but the body was never buffered whole.
    expect(pulls).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it("probes the audio half so the size guard counts both tracks", async () => {
    const { fetchFn, onDescriptor, handle } = harness(async () => response("video/mp4", FTYP_HEAD));
    fetchFn.mockImplementation(async (url: string) =>
      url === AUDIO_URL
        ? response("audio/mp4", FTYP_HEAD, { "content-range": "bytes 0-0/44444444" })
        : response("video/mp4", FTYP_HEAD, { "content-range": "bytes 0-4095/123456789" }));

    await handle(7, captureMsg(VIDEO_URL, AUDIO_URL));

    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.variants[0]!.estimatedSize).toBe(123456789);
    expect(d.audioRenditions![0]!.estimatedSize).toBe(44444444);
    expect(fetchFn).toHaveBeenCalledWith(
      AUDIO_URL,
      expect.objectContaining({ headers: { range: "bytes=0-0" } }),
    );
  });

  it("a failed audio probe leaves the audio size unknown without dropping the pair", async () => {
    const { fetchFn, onDescriptor, handle } = harness(async () => response("video/mp4", FTYP_HEAD));
    fetchFn.mockImplementation(async (url: string) => {
      if (url === AUDIO_URL) throw new Error("net::ERR_FAILED");
      return response("video/mp4", FTYP_HEAD, { "content-range": "bytes 0-4095/123456789" });
    });

    await handle(7, captureMsg(VIDEO_URL, AUDIO_URL));

    expect(onDescriptor).toHaveBeenCalledTimes(1);
    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.audioRenditions![0]!.estimatedSize).toBeNull();
  });
});
