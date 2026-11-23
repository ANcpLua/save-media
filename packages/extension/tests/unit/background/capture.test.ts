import { describe, expect, it, vi } from "vitest";
import {
  createCaptureHandler, MAX_ASKED_PROBES, MAX_FRAME_PROBES, MAX_TAB_PROBES, MAX_WAITING_PROBES,
  demuxedPairDescriptor,
  type CaptureDeps,
  type CaptureFetchResponse,
  type CaptureMessage,
} from "../../../src/background/capture";
import { MAIN_BRIDGE_TAG } from "../../../src/types/messages";
import { directDescriptor, hlsDescriptor } from "../popup/helpers/descriptors";
import { box, concat, initSegment } from "../engine/helpers/iso-bmff";
import { dispatch } from "@savemedia/core";
import type { JobError, StreamDescriptor, UserChoice } from "@savemedia/core";
import { noWaits, waitsOf } from "../helpers/waits";

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
  let bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const range = /^bytes (\d+)-(\d+)\//.exec(extraHeaders["content-range"] ?? "");
  if (range) {
    const ranged = new Uint8Array(Number(range[2]) - Number(range[1]) + 1);
    ranged.set(bytes.subarray(0, ranged.length));
    bytes = ranged;
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    status: range ? 206 : 200,
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
  const onDescriptor = vi.fn<(tabId: number, descriptor: StreamDescriptor) => void>();
  const handle = createCaptureHandler({ fetchFn, onDescriptor });
  return { fetchFn, onDescriptor, handle };
}

describe("capture handler — demuxed pairs", () => {
  it("carries verified direct-file quality metadata without changing its download URL", async () => {
    const { handle, onDescriptor } = harness(async () => response("video/mp4", FTYP_HEAD));
    const msg = captureMsg("https://cdn.example/high.mp4/?token=sample");
    await handle(7, { ...msg, payload: { ...msg.payload, quality: { groupId: "player-one", height: 720 } } });
    const descriptor = onDescriptor.mock.calls[0]![1];
    expect(descriptor.mediaGroup).toBe("player-one");
    expect(descriptor.variants[0]).toMatchObject({ height: 720, segmentRef: { kind: "direct", url: msg.payload.url } });
    expect(dispatch(descriptor, bestChoice)).toMatchObject({ kind: "direct", url: msg.payload.url });
  });

  it("never surfaces a quality candidate whose media probe fails", async () => {
    const { handle, onDescriptor } = harness(async () => ({ ...response("text/html", "login"), status: 403 }));
    const msg = captureMsg("https://cdn.example/restricted.mp4");
    await handle(7, { ...msg, payload: { ...msg.payload, quality: { groupId: "player-one", height: 1080 } } });
    expect(onDescriptor).not.toHaveBeenCalled();
  });
  it("coalesces concurrent probes of the same media in one tab", async () => {
    const { handle, fetchFn, onDescriptor } = harness(async () => response("video/mp4", FTYP_HEAD));
    const msg = captureMsg("https://cdn.example/clip.mp4");
    await Promise.all([handle(7, msg), handle(7, msg)]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onDescriptor).toHaveBeenCalledTimes(1);
  });

  it("aborts an old page's probe without reporting a failure on the new page", async () => {
    let signal: AbortSignal | undefined;
    const onDescriptor = vi.fn();
    const onFailure = vi.fn();
    const handle = createCaptureHandler({ onDescriptor, onFailure, fetchFn: async (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    } });
    const pending = handle(7, captureMsg("https://cdn.example/clip.mp4"));
    handle.clearTab(7);
    expect(signal?.aborted).toBe(true);
    await pending;
    expect(onDescriptor).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

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
    expect(dispatch(d, bestChoice)).toMatchObject({ kind: "refuse", reason: "output_too_large_for_browser" });
  });

  it("falls back to content-length when the server ignores the range probe", async () => {
    const { onDescriptor, handle } = harness(async () =>
      response("video/mp4", FTYP_HEAD, { "content-length": "123456789" }));

    await handle(7, captureMsg(VIDEO_URL, AUDIO_URL));

    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.variants[0]!.estimatedSize).toBe(123456789);
  });

  it("reports a direct MP4 whose probed movie box declares Common Encryption as protected, never as a file to save", async () => {
    const { onDescriptor, handle } = harness(async () => response("video/mp4", initSegment({ scheme: "cbcs", pssh: true })));
    await handle(1, captureMsg("https://cdn.example/representation-1080.mp4"));
    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.drm).toEqual({ reason: "cdm_required", detectedVia: ["mp4-protection"], keySystem: "com.widevine.alpha" });
    expect(d.capabilities).toEqual({ directDownload: false, remuxableTo: [] });
    expect(dispatch(d, bestChoice)).toEqual({ kind: "refuse", reason: "cdm_required" });
  });

  it("reports a direct WebM whose probed track declares ContentEncryption as protected", async () => {
    const id = (bytes: number[], ...children: Uint8Array[]) => {
      const payload = Uint8Array.from(children.flatMap(child => [...child]));
      return Uint8Array.from([...bytes, 0x10, 0, payload.length >> 8, payload.length & 0xff, ...payload]);
    };
    const encryption = id([0x6d, 0x80], id([0x62, 0x40], id([0x50, 0x33], Uint8Array.of(1)), id([0x50, 0x35], id([0x47, 0xe1], Uint8Array.of(5)))));
    const head = Uint8Array.from([...id([0x1a, 0x45, 0xdf, 0xa3], id([0x42, 0x82], new TextEncoder().encode("webm"))),
      0x18, 0x53, 0x80, 0x67, 0xff, ...id([0x16, 0x54, 0xae, 0x6b], id([0xae], id([0x86], new TextEncoder().encode("V_VP9")), encryption))]);
    const { onDescriptor, handle } = harness(async () => response("video/webm", head));
    await handle(1, captureMsg("https://cdn.example/representation-1080.webm"));
    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.drm).toEqual({ reason: "cdm_required", detectedVia: ["matroska-protection"], keySystem: null });
    expect(dispatch(d, bestChoice)).toEqual({ kind: "refuse", reason: "cdm_required" });
  });

  it("leaves plain progressive captures on the direct path", async () => {
    const { fetchFn, onDescriptor, handle } = harness(async () => response("video/mp4", FTYP_HEAD));

    await handle(1, captureMsg("https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/high.mp4"));

    expect(onDescriptor).toHaveBeenCalledTimes(1);
    const [, d] = onDescriptor.mock.calls[0]!;
    expect(d.protocol).toBe("progressive-http");
    expect(d.source.kind).toBe("direct-url");
    expect(d.capabilities.directDownload).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ credentials: "include", headers: { range: "bytes=0-4095" } }));
  });

  it("lists one fragmented MP4 file under a DASH brand as the direct file it is, and an init section alone as no file", async () => {
    const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));
    const brand = box("ftyp", ascii("dash"), [0, 0, 0, 0], ascii("iso6dash"));
    const clear = initSegment();
    const movie = clear.subarray(new DataView(clear.buffer).getUint32(0));
    const file = concat(brand, movie, box("moof", box("mfhd", new Array(8).fill(0))), box("mdat", [1, 2, 3, 4]));

    const whole = harness(async () => response("video/mp4", file, { "content-length": String(file.length) }));
    await whole.handle(1, captureMsg("https://cdn.example/clip.mp4"));
    expect(whole.onDescriptor).toHaveBeenCalledTimes(1);
    const [, listed] = whole.onDescriptor.mock.calls[0]!;
    expect(listed).toMatchObject({ protocol: "progressive-http", container: "mp4", drm: null, capabilities: { directDownload: true } });
    expect(dispatch(listed, bestChoice)).toMatchObject({ kind: "direct", url: "https://cdn.example/clip.mp4" });

    const init = concat(brand, movie);
    const section = harness(async () => response("video/mp4", init, { "content-length": String(init.length) }));
    await section.handle(1, captureMsg("https://cdn.example/init.mp4"));
    expect(section.onDescriptor).not.toHaveBeenCalled();
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
    expect(pair.capabilities).toEqual({ directDownload: false, remuxableTo: [] });
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
  it("detects an extensionless media URL on a server that only serves ranges", async () => {
    const { onDescriptor, handle } = harness(async (_url, init) => {
      if (!init.headers?.range) return { ...response("text/html", "unavailable"), status: 503 };
      return response("video/mp4", FTYP_HEAD, {
        "content-range": `bytes 0-${FTYP_HEAD.length - 1}/${FTYP_HEAD.length}`, etag: '"v1"',
      });
    });
    await handle(1, captureMsg("https://cdn.example/stream?id=opaque"));
    expect(onDescriptor).toHaveBeenCalledWith(1, expect.objectContaining({
      capabilities: expect.objectContaining({ directDownload: true }),
    }), null);
  });

  it("reports an exhausted server probe instead of silently treating it as absent media", async () => {
    const waits = noWaits();
    const onFailure = vi.fn();
    const onDescriptor = vi.fn();
    const fetchFn = vi.fn(async () => ({ ...response("text/html", "unavailable"), status: 503 }));
    const handle = createCaptureHandler({ fetchFn, onDescriptor, onFailure });

    await handle(7, captureMsg("https://cdn.example/clip.mp4"));

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(waitsOf(waits)).toEqual([1000, 2000]);
    expect(onDescriptor).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith(7, {
      url: "https://cdn.example/clip.mp4",
      error: expect.objectContaining({ code: "server_busy", httpStatus: 503 }),
    }, null);
  });

  it("reads extensionless manifests in full after the bounded first request", async () => {
    const manifest = `#EXTM3U\n#${"padding".repeat(700)}\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nvideo.m3u8\n`;
    const { fetchFn, onDescriptor, handle } = harness(async () => response("application/vnd.apple.mpegurl", manifest));
    const message = captureMsg("https://cdn.example/manifest?id=1");
    await handle(1, message);
    expect(fetchFn.mock.calls[0]![1].headers).toEqual({ range: "bytes=0-4095" });
    expect(fetchFn.mock.calls[1]![1].headers).toBeUndefined();
    expect(onDescriptor.mock.calls[0]![1].protocol).toBe("hls");
    expect(onDescriptor.mock.calls[0]![1].variants).toHaveLength(1);
  });

  it("detects a range-only direct video after a transient probe failure", async () => {
    const waits = noWaits();
    const { fetchFn, onDescriptor, handle } = harness(async (_url, init) => {
      if (init.headers?.range !== "bytes=0-4095") throw new TypeError("full request rejected");
      if (fetchFn.mock.calls.length === 1) {
        return { ...response("text/html", "unavailable"), status: 503 };
      }
      return {
        ...response("video/mp4", FTYP_HEAD, {
          "content-range": `bytes 0-${FTYP_HEAD.length - 1}/${FTYP_HEAD.length}`,
          etag: '"version-1"',
        }),
        status: 206,
      };
    });

    await handle(1, captureMsg("https://cdn.example/clip.mp4"));

    expect(onDescriptor).toHaveBeenCalledTimes(1);
    expect(onDescriptor.mock.calls[0]![1].capabilities.directDownload).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(waitsOf(waits)).toEqual([1000]);
  });

  it("installs the page's Referer rule before the first probe request", async () => {
    const order: string[] = [];
    const mirrorReferer = vi.fn(async () => { await Promise.resolve(); order.push("referer"); });
    const handle = createCaptureHandler({
      fetchFn: async () => { order.push("probe"); return response("video/mp4", FTYP_HEAD); },
      onDescriptor: vi.fn(),
      mirrorReferer,
    });
    await handle(1, { type: "capture", payload: {
      [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: "https://media.example/clip.mp4", pageUrl: "https://www.example/watch/1",
    } });
    expect(mirrorReferer).toHaveBeenCalledWith("https://media.example/clip.mp4", "https://www.example/watch/1", expect.stringMatching(/^probe:1:/));
    expect(order).toEqual(["referer", "probe"]);
  });

  it("holds the Referer rules of a check until the check ends, also when it fails, and each check under its own name", async () => {
    const events: string[] = [];
    const handle = createCaptureHandler({
      fetchFn: async url => { events.push(`request ${new URL(url).pathname}`); return url.includes("gone") ? { ...response("text/html", "no"), status: 404 } : response("video/mp4", FTYP_HEAD); },
      onDescriptor: () => { events.push("listed"); },
      onFailure: vi.fn(),
      mirrorReferer: async (url, _page, holder) => { events.push(`hold ${holder} ${new URL(url).host}`); },
      releaseReferer: holder => { events.push(`release ${holder}`); },
    });
    await handle(3, captureMsg("https://entry.example/clip.mp4"), { observedUrl: "https://cdn.example/clip.mp4" });
    await handle(3, captureMsg("https://entry.example/gone.mp4"));
    expect(events).toEqual([
      "hold probe:3:1 entry.example", "hold probe:3:1 cdn.example", "request /clip.mp4", "listed", "release probe:3:1",
      "hold probe:3:2 entry.example", "request /gone.mp4", "release probe:3:2",
    ]);
  });

  it("does not check an address longer than a page's own messages may name", async () => {
    const { fetchFn, handle } = harness(async () => response("video/mp4", FTYP_HEAD));
    await handle(1, captureMsg(`https://cdn.example/${"a".repeat(8200)}.mp4`));
    await handle(1, captureMsg("https://cdn.example/clip.mp4"), { observedUrl: `https://cdn.example/${"b".repeat(8200)}.mp4` });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never classifies an access-denied response as video", async () => {
    const { fetchFn, onDescriptor, handle } = harness(async () => ({
      ...response("video/mp4", FTYP_HEAD), status: 403,
    }));
    await handle(1, captureMsg("https://cdn.example/clip.mp4"));
    expect(onDescriptor).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

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

describe("capture handler — what it remembers, and what it never requests", () => {
  const PLAYLIST = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n";
  const origin = { frameId: 0, documentId: "doc-1", via: ["network-media"], scope: null } as const;

  function full(overrides: Partial<CaptureDeps> = {}, fetchImpl: CaptureDeps["fetchFn"] = async () => response("video/mp4", FTYP_HEAD)) {
    const fetchFn = vi.fn(fetchImpl);
    const spies = { onDescriptor: vi.fn<CaptureDeps["onDescriptor"]>(), onFailure: vi.fn<NonNullable<CaptureDeps["onFailure"]>>(),
      onSeen: vi.fn<NonNullable<CaptureDeps["onSeen"]>>(), onAds: vi.fn<NonNullable<CaptureDeps["onAds"]>>(), onTimeline: vi.fn<NonNullable<CaptureDeps["onTimeline"]>>() };
    return { ...spies, fetchFn, handle: createCaptureHandler({ fetchFn, ...spies, ...overrides }) };
  }

  it("never requests an address the page's ad responses named, as the address or as the redirect target", async () => {
    const { handle, fetchFn, onDescriptor, onFailure } = full({ isAd: (_tab, url) => url.includes("creative") });
    await handle(1, captureMsg("https://ads.example/creative.mp4"));
    await handle(1, captureMsg("https://cdn.example/entry.mp4"), { observedUrl: "https://ads.example/creative-final.mp4" });
    expect(fetchFn).not.toHaveBeenCalled();
    // Named, and nothing says the browser loaded it: it is not listed either.
    expect(onDescriptor).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("lists an ad the browser itself loaded from the browser's own answer, without a request, as a row that was not checked", async () => {
    const { handle, fetchFn, onDescriptor, onSeen, onFailure } = full({ isAd: (_tab, url) => url.includes("/ads/"), generation: () => 2 });
    const seen = { origin, observedHeaders: { "content-type": "video/mp4", "content-range": "bytes 0-4095/250000", "set-cookie": "id=1", "x-served-by": "edge" } };
    await handle(1, captureMsg("https://cdn.example/ads/creative.mp4"), seen);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(onDescriptor).toHaveBeenCalledTimes(1);
    const [tabId, row, where] = onDescriptor.mock.calls[0]!;
    expect(tabId).toBe(1);
    expect(row).toMatchObject({ unchecked: true, protocol: "progressive-http", container: "mp4",
      source: { kind: "direct-url", url: "https://cdn.example/ads/creative.mp4", headers: { "content-type": "video/mp4", "content-range": "bytes 0-4095/250000" } },
      capabilities: { directDownload: true } });
    // Only the headers a row is classified from are kept.
    expect(Object.keys((row.source as { headers: object }).headers).sort()).toEqual(["content-range", "content-type"]);
    expect(where).toMatchObject({ frameId: origin.frameId, generation: 2 });

    // The player's next range requests for the same creative list nothing again: they only say where it was seen.
    await handle(1, captureMsg("https://cdn.example/ads/creative.mp4#t=3"), seen);
    await handle(1, captureMsg("https://cdn.example/ads/creative.mp4"), { origin });
    expect(onDescriptor).toHaveBeenCalledTimes(1);
    expect(onSeen).toHaveBeenCalledTimes(2);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("lists an ad playlist and an ad a media element loaded under an unhelpful type, and nothing a page merely fetched as data", async () => {
    const { handle, fetchFn, onDescriptor } = full({ isAd: () => true });
    await handle(1, captureMsg("https://ads.example/asset/media.m3u8"), { origin: { ...origin, via: ["network-fetch"] },
      observedHeaders: { "content-type": "application/vnd.apple.mpegurl" } });
    await handle(1, captureMsg("https://ads.example/get?id=7"), { origin, observedHeaders: { "content-type": "application/octet-stream" },
      observedUrl: "https://edge.ads.example/files/7" });
    await handle(1, captureMsg("https://ads.example/config"), { origin: { ...origin, via: ["network-fetch"] },
      observedHeaders: { "content-type": "application/json" } });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(onDescriptor.mock.calls.map(call => call[1])).toMatchObject([
      // The playlist was never read: the row has no qualities until the user's Save checks it.
      { unchecked: true, protocol: "hls", variants: [], source: { kind: "hls-manifest", manifestUrl: "https://ads.example/asset/media.m3u8" } },
      { unchecked: true, protocol: "progressive-http", capabilities: { directDownload: true },
        source: { kind: "direct-url", url: "https://ads.example/get?id=7", finalUrl: "https://edge.ads.example/files/7" } },
    ]);
  });

  it("checks a listed ad only when the user saves it, and then as any other address", async () => {
    const { handle, fetchFn, onDescriptor } = full({ isAd: () => true });
    const address = "https://ads.example/creative.mp4";
    await handle(1, captureMsg(address), { origin, observedHeaders: { "content-type": "video/mp4" } });
    expect(fetchFn).not.toHaveBeenCalled();
    // The user's Save: one check, with the user's cookies, and a row that is checked.
    await handle(1, captureMsg(address), { origin, adRequested: true, priority: true, credentials: "include" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onDescriptor).toHaveBeenCalledTimes(2);
    expect(onDescriptor.mock.calls[1]![1].unchecked).toBeUndefined();
    expect(onDescriptor.mock.calls[1]![1].confidence.container).toBe("confirmed");
    // Checked once: a second Save and the player's later requests ask the server nothing more.
    await handle(1, captureMsg(address), { origin, adRequested: true, priority: true, credentials: "include" });
    await handle(1, captureMsg(address), { origin, observedHeaders: { "content-type": "video/mp4" } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onDescriptor).toHaveBeenCalledTimes(2);
  });

  it("stops a check that is under way when its address is named as an ad, and lists what the browser had received", async () => {
    let signal: AbortSignal | undefined;
    const marked = new Set<string>();
    const { handle, onDescriptor, onFailure, fetchFn } = full({ isAd: (_tab, url) => marked.has(url) }, async (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }));
    });
    const pending = handle(1, captureMsg("https://cdn.example/spot.mp4"), { origin, observedHeaders: { "content-type": "video/mp4" } });
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The ad response arrives while the check waits for its answer.
    marked.add("https://cdn.example/spot.mp4");
    handle.abortUrl(1, "https://cdn.example/spot.mp4");
    await pending;
    await vi.waitFor(() => expect(onDescriptor).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(true);
    expect(onDescriptor.mock.calls[0]![1]).toMatchObject({ unchecked: true, source: { url: "https://cdn.example/spot.mp4" } });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("abortUrl stops a running check without a descriptor or a failure", async () => {
    let signal: AbortSignal | undefined;
    const { handle, onDescriptor, onFailure } = full({}, async (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }));
    });
    const pending = handle(1, captureMsg("https://cdn.example/creative.mp4#t=1"));
    await Promise.resolve();
    handle.abortUrl(1, "https://cdn.example/creative.mp4");
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(onDescriptor).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("checks a known address once: later requests, seeks and rescans cost no request", async () => {
    const { handle, fetchFn, onDescriptor, onSeen } = full({ generation: () => 3 });
    const msg = captureMsg("https://cdn.example/clip.mp4");
    await handle(1, msg, { origin });
    await handle(1, msg, { origin });
    await handle(1, captureMsg("https://cdn.example/clip.mp4#t=30"), { origin: { ...origin, frameId: 4 } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onDescriptor).toHaveBeenCalledTimes(1);
    // The page whose Referer the check sent travels with where the address was seen.
    expect(onDescriptor.mock.calls[0]![2]).toEqual({ ...origin, generation: 3, referrer: new URL(msg.payload.pageUrl).origin });
    expect(onSeen).toHaveBeenCalledTimes(2);
    expect(onSeen).toHaveBeenLastCalledWith(1, "https://cdn.example/clip.mp4",
      { ...origin, frameId: 4, generation: 3, referrer: new URL(msg.payload.pageUrl).origin });
  });

  it("checks a known address again only when the page adds a name or a quality it lacked", async () => {
    const { handle, fetchFn, onDescriptor } = full();
    const msg = captureMsg("https://cdn.example/clip.mp4");
    await handle(1, msg);
    const named = { ...msg, payload: { ...msg.payload, filenameHint: "Talk 7.mp4", quality: { groupId: "g", height: 720 } } };
    await handle(1, named);
    await handle(1, named);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onDescriptor.mock.calls[1]![1]).toMatchObject({ mediaGroup: "g" });
  });

  it("skips an address that failed on this route, until the route changes or the user asks again", async () => {
    let generation = 0;
    const { handle, fetchFn, onFailure } = full({ generation: () => generation },
      async () => ({ ...response("text/html", "gone"), status: 404 }));
    const msg = captureMsg("https://cdn.example/gone.mp4");
    await handle(1, msg, { origin });
    await handle(1, msg, { origin });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    await handle(1, msg, { origin, retryFailed: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    generation = 1;
    await handle(1, msg, { origin });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("stamps the route generation when the capture starts, not when the probe ends", async () => {
    let generation = 5;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const { handle, onDescriptor } = full({ generation: () => generation }, async () => { await held; return response("video/mp4", FTYP_HEAD); });
    const pending = handle(1, captureMsg("https://cdn.example/clip.mp4"), { origin });
    generation = 6;
    release();
    await pending;
    expect(onDescriptor.mock.calls[0]![2]).toMatchObject({ generation: 5 });
  });

  it("asks for the first bytes of a .m3u8 before it reads the playlist, and states its timeline", async () => {
    const { handle, fetchFn, onDescriptor, onTimeline } = full({}, async () => response("application/vnd.apple.mpegurl", PLAYLIST));
    await handle(1, captureMsg("https://cdn.example/v/media.m3u8"));
    expect(fetchFn.mock.calls[0]![1].headers).toEqual({ range: "bytes=0-4095" });
    expect(fetchFn.mock.calls[1]![1].headers).toBeUndefined();
    expect(fetchFn.mock.calls[1]![1].cache).toBe("default");
    expect(onDescriptor.mock.calls[0]![1]).toMatchObject({ protocol: "hls", presentation: { live: false, durationSeconds: 4, maxSegmentSeconds: 4 } });
    expect(onTimeline).toHaveBeenCalledWith(1, "https://cdn.example/v/media.m3u8", { live: false, durationSeconds: 4, maxSegmentSeconds: 4 });
  });

  it("treats a page under a .m3u8 name as the page it is", async () => {
    const { handle, onDescriptor, onFailure } = full({}, async () => response("text/html", "<!doctype html><html><body>Sign in</body></html>"));
    await handle(1, captureMsg("https://cdn.example/v/media.m3u8"));
    expect(onDescriptor).not.toHaveBeenCalled();
    expect(onFailure.mock.calls[0]![1].error).toMatchObject({ code: "unexpected_media_response", response: "page" });
  });

  it("does not fetch a live playlist again on each reload, with or without delivery directives", async () => {
    const live = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\nseg7.ts\n";
    const { handle, fetchFn, onDescriptor } = full({}, async () => response("application/vnd.apple.mpegurl", live));
    await handle(1, captureMsg("https://cdn.example/720p/playlist.m3u8?token=1"));
    const requests = fetchFn.mock.calls.length;
    for (let part = 0; part < 20; part++) await handle(1, captureMsg(`https://cdn.example/720p/playlist.m3u8?token=1&_HLS_msn=${part}&_HLS_part=1`));
    expect(fetchFn).toHaveBeenCalledTimes(requests);
    expect(onDescriptor).toHaveBeenCalledTimes(1);
    expect(onDescriptor.mock.calls[0]![1].presentation?.live).toBe(true);
  });

  it("marks the interstitial assets a playlist schedules as ads and never requests them", async () => {
    const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-DATERANGE:ID="ad",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:00:00Z",X-ASSET-URI="https://ads.example/ad/media.m3u8"\n#EXT-X-DATERANGE:ID="ad2",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:01:00Z",X-ASSET-LIST="https://ads.example/list.json"\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n`;
    const { handle, fetchFn, onAds } = full({}, async () => response("application/vnd.apple.mpegurl", playlist));
    await handle(1, captureMsg("https://cdn.example/v/media.m3u8"));
    expect(onAds).toHaveBeenCalledWith(1, ["https://ads.example/ad/media.m3u8"], "hls-interstitial", ["https://ads.example/list.json"], 0);
    expect(fetchFn.mock.calls.every(call => !String(call[0]).includes("ads.example"))).toBe(true);
  });

  it("lists what a script fetched only when its first bytes begin a whole file, and lets a part of a stream go without a word", async () => {
    const text = (value: string): number[] => [...value].map(char => char.charCodeAt(0));
    const box = (type: string, body: readonly number[] = []): number[] => [0, 0, 0, 8 + body.length, ...text(type), ...body];
    const filler = (length: number): number[] => new Array<number>(length).fill(0);
    const ftyp = box("ftyp", [...text("isom"), 0, 0, 0, 0]);
    const whole = new Uint8Array([...ftyp, ...box("moov", [...box("mvhd", filler(20)), ...box("trak", filler(20))]), ...box("mdat", filler(32))]);
    const init = new Uint8Array([...ftyp, ...box("moov", [...box("mvhd", filler(20)), ...box("trak", filler(20)), ...box("mvex", box("trex", filler(8)))])]);
    const fragment = new Uint8Array([...box("styp", [...text("msdh"), 0, 0, 0, 0]), ...box("moof", filler(16)), ...box("mdat", filler(16))]);
    const asked = { origin: { frameId: 0, documentId: "doc-0", via: ["network-fetch" as const], scope: null }, wholeFile: true, credentials: "include" as const };
    const run = async (bytes: Uint8Array | string, type = "video/mp4") => {
      const onPart = vi.fn();
      const made = full({ onPart }, async () => response(type, bytes, typeof bytes === "string" ? {} : { "content-length": String(bytes.length) }));
      await made.handle(1, captureMsg("https://cdn.example/v/clip.mp4"), asked);
      return { ...made, onPart };
    };
    // The file a page fetched and plays from memory.
    const file = await run(whole);
    expect(file.onDescriptor).toHaveBeenCalledTimes(1);
    expect(file.onDescriptor.mock.calls[0]![1]).toMatchObject({ container: "mp4", capabilities: { directDownload: true }, source: { kind: "direct-url", url: "https://cdn.example/v/clip.mp4" } });
    expect(file.onDescriptor.mock.calls[0]![2]).toMatchObject({ frameId: 0, via: ["network-fetch"] });
    expect(file.onPart).not.toHaveBeenCalled();
    // The init section and a fragment of a stream a player is fed piece by piece, and an answer that is no video:
    // none is listed, none is a failed source, and each is given back as looked at.
    for (const [name, bytes, type] of [["init section", init, "video/mp4"], ["fragment", fragment, "video/mp4"],
      ["web page", "<!doctype html><title>Sign in</title>", "text/html"], ["data", "{\"error\":\"expired\"}", "application/json"]] as const) {
      const part = await run(bytes, type);
      expect(part.onDescriptor, name).not.toHaveBeenCalled();
      expect(part.onFailure, name).not.toHaveBeenCalled();
      expect(part.onPart, name).toHaveBeenCalledExactlyOnceWith(1, "https://cdn.example/v/clip.mp4");
    }
    // The same bytes behind a media element's own request are that element's file, as before.
    const element = full({}, async () => response("video/mp4", init, { "content-length": String(init.length) }));
    await element.handle(1, captureMsg("https://cdn.example/v/clip.mp4"), { origin });
    expect(element.onDescriptor).toHaveBeenCalledTimes(1);
    // A check that fails lists nothing and explains nothing: the page got its answer, so this is no source
    // the page failed to load. A final ending (a server that refuses savemedia's request because the page sent
    // a header or a token savemedia does not have, a file that is gone) gives the address back as looked at,
    // so it is not asked about again. A temporary one (a busy server, a lost connection) keeps it, so the
    // next look asks again instead of losing a real file until the page is reloaded.
    for (const [name, answer, final] of [
      ["refused", async () => ({ ...response("text/plain", "no"), status: 403 }), true],
      ["sign-in needed", async () => ({ ...response("text/plain", "no"), status: 401 }), true],
      ["gone", async () => ({ ...response("text/plain", "no"), status: 404 }), true],
      ["busy", async () => ({ ...response("text/plain", "no"), status: 503 }), false],
      ["network", async () => { throw new TypeError("Failed to fetch"); }, false],
    ] as const) {
      const onPart = vi.fn();
      const explain = vi.fn(async (failure: JobError) => failure);
      const failed = full({ onPart, explain }, answer as never);
      await failed.handle(1, captureMsg("https://cdn.example/v/clip.mp4"), asked);
      expect(failed.onFailure, name).not.toHaveBeenCalled();
      expect(failed.onDescriptor, name).not.toHaveBeenCalled();
      expect(explain, name).not.toHaveBeenCalled();
      if (final) expect(onPart, name).toHaveBeenCalledExactlyOnceWith(1, "https://cdn.example/v/clip.mp4");
      else expect(onPart, name).not.toHaveBeenCalled();
    }
    // The same refusal behind a media element's own request is that element's failed source, as before.
    const elementRefused = full({}, async () => ({ ...response("text/plain", "no"), status: 403 }));
    await elementRefused.handle(1, captureMsg("https://cdn.example/v/clip.mp4"), { origin });
    expect(elementRefused.onFailure).toHaveBeenCalledTimes(1);
    expect(elementRefused.onFailure.mock.calls[0]![1]).toMatchObject({ error: { code: "access_denied" } });
  });

  it("never requests a name that only resolves inside the user's network when a public page only names it", async () => {
    const { handle, fetchFn, onDescriptor, onFailure } = full();
    const targets = ["http://nas/cgi-bin/x.mp4", "http://router.home.arpa/x.mp4", "http://printer.internal/clip.mp4"];
    for (const target of targets) await handle(1, captureMsg(target), { referrerPage: "https://evil.example/" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(onDescriptor).not.toHaveBeenCalled();
    // No address is named: nothing was asked, so nothing answered.
    expect(onFailure.mock.calls.map(call => call[1])).toEqual(targets.map(url =>
      ({ url, error: { code: "private_network_target", severity: "terminal", host: new URL(url).host } })));
    // A page that is itself under such a name may use its own server.
    const inside = full();
    await inside.handle(1, captureMsg("http://intranet/media/onboarding.mp4"), { referrerPage: "http://intranet/training" });
    expect(inside.fetchFn).toHaveBeenCalledTimes(1);
    expect(inside.onDescriptor).toHaveBeenCalledTimes(1);
  });

  it("never requests a server inside the user's network that a public page only names: by its link, its server address or a redirect", async () => {
    const { handle, fetchFn, onDescriptor, onFailure } = full();
    const forged = captureMsg("http://192.168.1.1/apply.cgi?action=reboot&x=.m3u8");
    await handle(1, { ...forged, payload: { ...forged.payload, pageUrl: "https://evil.example/" } }, { referrerPage: "https://evil.example/" });
    await handle(1, captureMsg("https://rebind.example/x.mp4"), { referrerPage: "https://evil.example/", serverIp: "10.0.0.7" });
    expect(fetchFn).not.toHaveBeenCalled();
    // Nothing was requested, and the user is told why neither source is listed.
    expect(onFailure.mock.calls.map(call => call[1])).toEqual([
      { url: "http://192.168.1.1/apply.cgi?action=reboot&x=.m3u8", error: { code: "private_network_target", severity: "terminal", host: "192.168.1.1" } },
      { url: "https://rebind.example/x.mp4", error: { code: "private_network_target", severity: "terminal", host: "rebind.example", ip: "10.0.0.7" } },
    ]);

    // A public name that resolves into the user's network: known from the address the browser reports for
    // savemedia's own request. That one request has left; nothing of its answer is used.
    const answers = new WeakSet<object>();
    const rebound = full({ serverHops: answer => answers.has(answer) ? [{ url: "https://rebind.example/x.mp4", ip: "192.168.1.1" }] : [] }, async () => {
      const answer = response("video/mp4", FTYP_HEAD);
      answers.add(answer);
      return answer;
    });
    await rebound.handle(1, captureMsg("https://rebind.example/x.mp4"), { referrerPage: "https://evil.example/" });
    expect(rebound.fetchFn).toHaveBeenCalledTimes(1);
    expect(rebound.onDescriptor).not.toHaveBeenCalled();
    // The failure names where the public name led. It carries nothing of the answer.
    expect(rebound.onFailure.mock.calls.map(call => call[1])).toEqual([
      { url: "https://rebind.example/x.mp4", error: { code: "private_network_target", severity: "terminal", host: "rebind.example", ip: "192.168.1.1" } }]);
    // The same answer from a public server address is used.
    const fine = full({ serverHops: () => [{ url: "https://cdn.example/x.mp4", ip: "93.184.216.34" }] });
    await fine.handle(1, captureMsg("https://cdn.example/x.mp4"), { referrerPage: "https://news.example/" });
    expect(fine.onDescriptor).toHaveBeenCalledTimes(1);

    const redirected = full({}, async () => ({ ...response("video/mp4", FTYP_HEAD), url: "http://127.0.0.1:8080/admin.mp4" }));
    await redirected.handle(1, captureMsg("https://public.example/go.mp4"), { referrerPage: "https://evil.example/" });
    expect(redirected.fetchFn).toHaveBeenCalledTimes(1);
    expect(redirected.onDescriptor).not.toHaveBeenCalled();
    // A secure address that was sent on to this computer over a secure link is named as what it is.
    const secure = full({}, async () => ({ ...response("video/mp4", FTYP_HEAD), url: "https://127.0.0.1:8443/admin.mp4" }));
    await secure.handle(1, captureMsg("https://public.example/go.mp4"), { referrerPage: "https://evil.example/" });
    expect(secure.onDescriptor).not.toHaveBeenCalled();
    expect(secure.onFailure.mock.calls.map(call => call[1])).toEqual([
      { url: "https://public.example/go.mp4", error: { code: "private_network_target", severity: "terminal", host: "public.example", ip: "127.0.0.1" } }]);
    expect(onDescriptor).not.toHaveBeenCalled();
  });

  it("checks and lists a local server's media for a public page once the browser itself was answered from that origin there", async () => {
    const PAGE_URL = "https://news.example/story";
    // What the browser's own request events noted for the tab: origins, each with the tab they were seen in.
    const seen = new Set(["1 http://192.168.1.10", "1 https://media.corp-portal.net"]);
    const observedLocal = (tabId: number, url: string): boolean => seen.has(`${tabId} ${new URL(url).origin}`);
    const at = (url: string, ip: string) => ({ serverHops: () => [{ url, ip }], observedLocal });

    // A video element that plays a file from a device on the user's network.
    const literal = full(at("http://192.168.1.10/movie.mp4", "192.168.1.10"));
    const named = captureMsg("http://192.168.1.10/movie.mp4");
    await literal.handle(1, { ...named, payload: { ...named.payload, pageUrl: PAGE_URL } }, { referrerPage: PAGE_URL, serverIp: "192.168.1.10" });
    expect(literal.fetchFn).toHaveBeenCalled();
    expect(literal.onDescriptor).toHaveBeenCalledTimes(1);
    expect(literal.onFailure).not.toHaveBeenCalled();

    // A portal with a public name whose media name resolves into the company network.
    const portal = full(at("https://media.corp-portal.net/v/clip.mp4", "10.20.0.5"));
    await portal.handle(1, captureMsg("https://media.corp-portal.net/v/clip.mp4"), { referrerPage: "https://corp-portal.net/watch", serverIp: "10.20.0.5" });
    expect(portal.onDescriptor).toHaveBeenCalledTimes(1);
    expect(portal.onFailure).not.toHaveBeenCalled();

    // The same addresses in a tab whose browser was never answered from there stay unrequested.
    const other = full(at("http://192.168.1.10/movie.mp4", "192.168.1.10"));
    await other.handle(2, { ...named, payload: { ...named.payload, pageUrl: PAGE_URL } }, { referrerPage: PAGE_URL });
    expect(other.fetchFn).not.toHaveBeenCalled();
    expect(other.onFailure.mock.calls.map(call => call[1])).toEqual([
      { url: "http://192.168.1.10/movie.mp4", error: { code: "private_network_target", severity: "terminal", host: "192.168.1.10" } }]);

    // Another port of the same device is another server: the browser was not there.
    const port = full(at("http://192.168.1.10:8080/admin.mp4", "192.168.1.10"));
    const admin = captureMsg("http://192.168.1.10:8080/admin.mp4");
    await port.handle(1, { ...admin, payload: { ...admin.payload, pageUrl: PAGE_URL } }, { referrerPage: PAGE_URL });
    expect(port.fetchFn).not.toHaveBeenCalled();
    expect(port.onDescriptor).not.toHaveBeenCalled();
  });

  it("drops an answer whose redirect led from a server the browser was at to a local one it was not at, and keeps one that stayed", async () => {
    const observedLocal = (_tabId: number, url: string): boolean => new URL(url).origin === "https://media.corp-portal.net";
    const hop = (url: string, ip: string) => ({ url, ip });
    // The portal's own media server redirects to a router's address.
    const away = full({ observedLocal, serverHops: () => [hop("https://media.corp-portal.net/v/clip.mp4", "10.20.0.5"), hop("https://router.corp-portal.net/x.mp4", "10.0.0.1")] },
      async () => ({ ...response("video/mp4", FTYP_HEAD), url: "https://router.corp-portal.net/x.mp4" }));
    await away.handle(1, captureMsg("https://media.corp-portal.net/v/clip.mp4"), { referrerPage: "https://corp-portal.net/watch" });
    expect(away.onDescriptor).not.toHaveBeenCalled();
    expect(away.onFailure.mock.calls.map(call => call[1])).toEqual([{ url: "https://media.corp-portal.net/v/clip.mp4",
      error: { code: "private_network_target", severity: "terminal", host: "media.corp-portal.net", ip: "10.0.0.1" } }]);

    // A public address that redirects to the server the browser was answered from is that server's answer.
    const into = full({ observedLocal, serverHops: () => [hop("https://go.corp-portal.net/v", "93.184.216.34"), hop("https://media.corp-portal.net/v/clip.mp4", "10.20.0.5")] },
      async () => ({ ...response("video/mp4", FTYP_HEAD), url: "https://media.corp-portal.net/v/clip.mp4" }));
    await into.handle(1, captureMsg("https://go.corp-portal.net/v"), { referrerPage: "https://corp-portal.net/watch" });
    expect(into.onDescriptor).toHaveBeenCalledTimes(1);
    expect(into.onFailure).not.toHaveBeenCalled();
  });

  // Behind a proxy inside the user's network the browser reports the proxy's address for every server. On an
  // intranet page with a name of its own, the page's own server is at a local address. In both, the browser
  // itself reached the tab's page under a public name at a local address, and that is what is known.
  it("uses an answer the browser reports from a local address when the browser reaches the tab's own page there: a proxy, or an intranet name", async () => {
    const hop = (url: string, ip: string) => ({ url, ip });
    const behindProxy = (_tabId: number, url: string): boolean => new URL(url).origin === "https://www.news-site.net";
    const explain = vi.fn(async (error: unknown) => error as never);

    // A file link on a page behind a proxy at 127.0.0.1: the browser never loads such a link itself.
    const file = full({ observedLocal: behindProxy, serverHops: () => [hop("https://files.cdn-site.net/movie.mp4", "127.0.0.1")] });
    const link = captureMsg("https://files.cdn-site.net/movie.mp4");
    await file.handle(1, { ...link, payload: { ...link.payload, pageUrl: "https://www.news-site.net/story" } }, { referrerPage: "https://www.news-site.net/story" });
    expect(file.onDescriptor).toHaveBeenCalledTimes(1);
    expect(file.onFailure).not.toHaveBeenCalled();

    // A page under an intranet name with a download link to its own server.
    const intranet = (_tabId: number, url: string): boolean => new URL(url).origin === "http://wiki.corp-site.net:8080";
    const own = full({ observedLocal: intranet, serverHops: () => [hop("http://wiki.corp-site.net:8080/files/training.mp4", "10.1.2.3")] });
    const training = captureMsg("http://wiki.corp-site.net:8080/files/training.mp4");
    await own.handle(1, { ...training, payload: { ...training.payload, pageUrl: "http://wiki.corp-site.net:8080/training.html" } },
      { referrerPage: "http://wiki.corp-site.net:8080/training.html" });
    expect(own.onDescriptor).toHaveBeenCalledTimes(1);
    expect(own.onFailure).not.toHaveBeenCalled();

    // An address that is itself local stays unrequested until the browser was answered from it, behind a proxy too.
    const literal = full({ observedLocal: behindProxy });
    const router = captureMsg("http://192.168.1.1/x.mp4");
    await literal.handle(1, { ...router, payload: { ...router.payload, pageUrl: "https://www.news-site.net/story" } }, { referrerPage: "https://www.news-site.net/story" });
    expect(literal.fetchFn).not.toHaveBeenCalled();
    expect(literal.onFailure.mock.calls.map(call => call[1])).toEqual([
      { url: "http://192.168.1.1/x.mp4", error: { code: "private_network_target", severity: "terminal", host: "192.168.1.1" } }]);
    // So does a public name that redirects to an address that is itself local.
    const redirected = full({ observedLocal: behindProxy }, async () => ({ ...response("video/mp4", FTYP_HEAD), url: "http://127.0.0.1:8080/admin.mp4" }));
    const go = captureMsg("https://public.example/go.mp4");
    await redirected.handle(1, { ...go, payload: { ...go.payload, pageUrl: "https://www.news-site.net/story" } }, { referrerPage: "https://www.news-site.net/story" });
    expect(redirected.onDescriptor).not.toHaveBeenCalled();

    // A failure of such a tab is explained without the address the browser reported, which is the proxy's.
    const failing = full({ observedLocal: behindProxy, explain: explain as never, serverHops: () => [hop("https://files.cdn-site.net/gone.mp4", "127.0.0.1")] },
      async () => response("text/html", new TextEncoder().encode("<!doctype html><title>Gone</title>")));
    const gone = captureMsg("https://files.cdn-site.net/gone.mp4");
    await failing.handle(1, { ...gone, payload: { ...gone.payload, pageUrl: "https://www.news-site.net/story" } }, { referrerPage: "https://www.news-site.net/story" });
    expect(failing.onFailure.mock.calls[0]![1].error).toMatchObject({ code: "unexpected_media_response", response: "page" });
    expect(explain.mock.calls[0]![4 as never]).toBe(true);

    // A tab whose own page the browser reached at a public address keeps the rule: the answer is dropped.
    const elsewhere = full({ observedLocal: () => false, explain: explain as never, serverHops: () => [hop("https://files.cdn-site.net/movie.mp4", "127.0.0.1")] });
    await elsewhere.handle(1, { ...link, payload: { ...link.payload, pageUrl: "https://www.news-site.net/story" } }, { referrerPage: "https://www.news-site.net/story" });
    expect(elsewhere.onDescriptor).not.toHaveBeenCalled();
    expect(elsewhere.onFailure.mock.calls.map(call => call[1].error)).toEqual([
      { code: "private_network_target", severity: "terminal", host: "files.cdn-site.net", ip: "127.0.0.1" }]);
  });

  it("adds what the browser reported about the check's own request to a failure, and the server's name to a page answer", async () => {
    const explain = vi.fn(async (error: unknown, answer: object | null, url: string) => ({ ...(error as object), explainedFor: url, hadAnswer: answer !== null }));
    const page = full({ explain: explain as never }, async () => response("text/html", new TextEncoder().encode("<!doctype html><title>Blocked</title>")));
    await page.handle(1, captureMsg("https://cdn.example/x.mp4"));
    expect(explain).toHaveBeenCalledOnce();
    expect(page.onFailure.mock.calls[0]![1]).toMatchObject({ url: "https://cdn.example/x.mp4",
      error: { code: "unexpected_media_response", response: "page", explainedFor: "https://cdn.example/x.mp4", hadAnswer: true } });
  });

  it("lets a page that is itself local use local servers", async () => {
    const { handle, onDescriptor } = full();
    const local = captureMsg("http://192.168.1.20:8096/Videos/1/stream.mp4");
    await handle(1, { ...local, payload: { ...local.payload, pageUrl: "http://192.168.1.20:8096/web/" } }, { referrerPage: "http://192.168.1.20:8096/web/" });
    expect(onDescriptor).toHaveBeenCalledTimes(1);
  });

  it("sends the user's cookies only when told the browser itself received the address", async () => {
    const { handle, fetchFn } = full();
    await handle(1, captureMsg("https://cdn.example/a.mp4"), { credentials: "omit" });
    await handle(1, captureMsg("https://cdn.example/b.mp4"), { credentials: "include" });
    expect(fetchFn.mock.calls[0]![1].credentials).toBe("omit");
    expect(fetchFn.mock.calls[1]![1].credentials).toBe("include");
  });

  it("stops reading a playlist above the limit and reports it plainly, without keeping the bytes", async () => {
    const chunk = new TextEncoder().encode("#EXTM3U\n" + "#EXTINF:1,\nsegment.ts\n".repeat(40_000));
    let pulled = 0;
    const endless = () => new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(chunk); } });
    const { handle, onDescriptor, onFailure } = full({}, async (_url, init) => init.headers?.range
      ? response("application/vnd.apple.mpegurl", "#EXTM3U\n")
      : response("application/vnd.apple.mpegurl", "", {}, endless()));
    await handle(1, captureMsg("https://evil.example/endless.m3u8"));
    expect(onDescriptor).not.toHaveBeenCalled();
    expect(onFailure.mock.calls[0]![1].error).toEqual({ code: "manifest_too_large", severity: "terminal", url: "https://evil.example/endless.m3u8", limit: "bytes" });
    expect(pulled).toBeLessThan(20);
  });

  it("refuses a small manifest that declares millions of segments, before any parser expands it", async () => {
    const bomb = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT3H"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="1" timescale="1000" media="s$Number$.m4s"/><Representation id="v" bandwidth="1" width="2" height="2"/></AdaptationSet></Period></MPD>`;
    const { handle, onDescriptor, onFailure } = full({}, async () => response("application/dash+xml", bomb));
    const started = Date.now();
    await handle(1, captureMsg("https://evil.example/x.mpd"));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(onDescriptor).not.toHaveBeenCalled();
    expect(onFailure.mock.calls[0]![1].error).toMatchObject({ code: "manifest_too_large", limit: "segments" });
  });

  it("forget lets a new document check an address again", async () => {
    const { handle, fetchFn } = full();
    await handle(1, captureMsg("https://cdn.example/clip.mp4"));
    handle.forget(1, ["https://cdn.example/clip.mp4"]);
    await handle(1, captureMsg("https://cdn.example/clip.mp4"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("ignores a capture that is not a media address", async () => {
    const { handle, fetchFn } = full();
    await handle(1, { type: "capture", payload: { [MAIN_BRIDGE_TAG]: true, kind: "ad-media", url: null, pageUrl: "https://p.example/", adUrls: ["https://ads.example/a.mp4"], adVia: "vast" } });
    await handle(1, captureMsg("blob:https://p.example/1"));
    await handle(1, captureMsg("https://user:pw@p.example/a.mp4"));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("capture handler — a page that loads very many media files", () => {
  /** A fetch that holds every request until the test opens the gate; from then on requests pass. */
  function gated() {
    const waiting: (() => void)[] = [];
    let open = false;
    let running = 0;
    let most = 0;
    const fetchFn = vi.fn(async () => {
      running++;
      most = Math.max(most, running);
      if (!open) await new Promise<void>(resolve => { waiting.push(resolve); });
      running--;
      return response("video/mp4", FTYP_HEAD);
    });
    const release = async (): Promise<void> => {
      open = true;
      for (const go of waiting.splice(0)) go();
    };
    return { fetchFn, release, most: () => most, started: () => fetchFn.mock.calls.length, held: () => waiting.length };
  }
  const flush = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

  it("checks a few at a time, in the order of arrival, and every one of them in the end", async () => {
    const gate = gated();
    const onDescriptor = vi.fn();
    const handle = createCaptureHandler({ fetchFn: gate.fetchFn as never, onDescriptor });
    const all = Array.from({ length: 40 }, (_, n) => handle(7, captureMsg(`https://cdn.example/feed/${n}.mp4`)));
    await flush();
    expect(gate.started()).toBe(MAX_FRAME_PROBES);
    // Another tab is not held up by this one.
    const other = handle(8, captureMsg("https://cdn.example/other.mp4"));
    await flush();
    expect(gate.started()).toBe(MAX_FRAME_PROBES + 1);
    await gate.release();
    await Promise.all([...all, other]);
    expect(gate.most()).toBeLessThanOrEqual(MAX_FRAME_PROBES + 1);
    expect(onDescriptor).toHaveBeenCalledTimes(41);
  });

  it("drops what a page piles up beyond the waiting limit, without a request and without a failure", async () => {
    const gate = gated();
    const onDescriptor = vi.fn();
    const onFailure = vi.fn();
    const handle = createCaptureHandler({ fetchFn: gate.fetchFn as never, onDescriptor, onFailure });
    const count = MAX_FRAME_PROBES + MAX_WAITING_PROBES + 500;
    const all = Array.from({ length: count }, (_, n) => handle(7, captureMsg(`https://evil.example/v${n}.mp4`)));
    await flush();
    expect(gate.started()).toBe(MAX_FRAME_PROBES);
    await gate.release();
    await Promise.all(all);
    expect(gate.started()).toBe(MAX_FRAME_PROBES + MAX_WAITING_PROBES);
    expect(onDescriptor).toHaveBeenCalledTimes(MAX_FRAME_PROBES + MAX_WAITING_PROBES);
    expect(onFailure).not.toHaveBeenCalled();
    // What was dropped is checked when the page asks for it again.
    await handle(7, captureMsg(`https://evil.example/v${count - 1}.mp4`));
    expect(gate.started()).toBe(MAX_FRAME_PROBES + MAX_WAITING_PROBES + 1);
  });

  const inFrame = (frameId: number) => ({ origin: { frameId, documentId: null, via: ["network-fetch" as const], scope: null } });

  it("runs a check the user asked for at once, however many checks of the page's own requests run or wait", async () => {
    const gate = gated();
    const order: string[] = [];
    const handle = createCaptureHandler({ fetchFn: (async (url: string) => { order.push(new URL(url).pathname); return gate.fetchFn(); }) as never, onDescriptor: vi.fn() });
    // Three frames with servers that never answer take every place the page's own requests have, and fill the waiting list.
    const passive = Array.from({ length: MAX_TAB_PROBES + MAX_WAITING_PROBES }, (_, n) =>
      handle(7, captureMsg(`https://ads.example/slow/${n}.m3u8`), inFrame(1 + n % 3)));
    await flush();
    expect(gate.started()).toBe(MAX_TAB_PROBES);
    const asked = handle(7, captureMsg("https://cdn.example/main.mp4"), { priority: true });
    await flush();
    // It did not wait for any of them.
    expect(order).toContain("/main.mp4");
    expect(gate.started()).toBe(MAX_TAB_PROBES + 1);
    await gate.release();
    await Promise.all([...passive, asked]);
  });

  it("runs the checks the user asked for a few at a time as well", async () => {
    const gate = gated();
    const handle = createCaptureHandler({ fetchFn: gate.fetchFn as never, onDescriptor: vi.fn() });
    const asked = Array.from({ length: MAX_ASKED_PROBES + 5 }, (_, n) => handle(7, captureMsg(`https://cdn.example/declared/${n}.mp4`), { priority: true }));
    await flush();
    expect(gate.started()).toBe(MAX_ASKED_PROBES);
    await gate.release();
    await Promise.all(asked);
    expect(gate.started()).toBe(MAX_ASKED_PROBES + 5);
  });

  it("leaves the other frames their places when one frame's servers are slow, and serves the frames in turn", async () => {
    const gate = gated();
    const order: string[] = [];
    const handle = createCaptureHandler({ fetchFn: (async (url: string) => { order.push(new URL(url).pathname); return gate.fetchFn(); }) as never, onDescriptor: vi.fn() });
    // An ad frame asks for thirty addresses before the page's own player asks for its first.
    const ads = Array.from({ length: 30 }, (_, n) => handle(7, captureMsg(`https://ads.example/a${n}.mp4`), inFrame(5)));
    await flush();
    expect(gate.started()).toBe(MAX_FRAME_PROBES);
    const main = handle(7, captureMsg("https://cdn.example/main.mp4"), inFrame(0));
    const second = handle(7, captureMsg("https://cdn.example/second.mp4"), inFrame(0));
    await flush();
    // The top frame's checks start at once, in the places the ad frame may not take.
    expect(order.slice(MAX_FRAME_PROBES)).toEqual(["/main.mp4", "/second.mp4"]);
    expect(gate.started()).toBe(MAX_TAB_PROBES);
    await gate.release();
    await Promise.all([...ads, main, second]);
    expect(gate.started()).toBe(32);
  });

  it("lets a waiting frame go next when every place was taken by other frames", async () => {
    const waiting: (() => void)[] = [];
    const order: string[] = [];
    const handle = createCaptureHandler({
      fetchFn: (async (url: string) => {
        order.push(new URL(url).pathname);
        await new Promise<void>(resolve => { waiting.push(resolve); });
        return response("video/mp4", FTYP_HEAD);
      }) as never,
      onDescriptor: vi.fn(),
    });
    // Two ad frames hold all places and have more waiting; then the player's frame asks.
    const ads = Array.from({ length: 20 }, (_, n) => handle(7, captureMsg(`https://ads.example/a${n}.mp4`), inFrame(5 + n % 2)));
    await flush();
    expect(order).toHaveLength(MAX_TAB_PROBES);
    void handle(7, captureMsg("https://cdn.example/main.mp4"), inFrame(0));
    await flush();
    expect(order).toHaveLength(MAX_TAB_PROBES);
    // One place comes free: it goes to the frame that has none, not to the next ad in line.
    waiting.shift()!();
    await flush();
    expect(order.at(-1)).toBe("/main.mp4");
    for (let round = 0; round < 40; round++) { for (const go of waiting.splice(0)) go(); await flush(); }
    await Promise.all(ads);
  });

  it("gives up a playlist that arrives a byte now and then, however long the server keeps sending", async () => {
    vi.useFakeTimers();
    try {
      const failures: unknown[] = [];
      let streams = 0;
      const handle = createCaptureHandler({
        fetchFn: (async (_url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => {
          if (init.headers?.range) return response("application/vnd.apple.mpegurl", "#EXTM3U\n", { "content-range": "bytes 0-7/8" });
          streams++;
          // The whole playlist: one byte every thirty seconds, for ever.
          let timer: ReturnType<typeof setInterval>;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              timer = setInterval(() => controller.enqueue(new Uint8Array([35])), 30_000);
              init.signal?.addEventListener("abort", () => { clearInterval(timer); controller.error(init.signal!.reason); });
            },
            cancel() { clearInterval(timer); },
          });
          return response("application/vnd.apple.mpegurl", "", {}, body);
        }) as never,
        onDescriptor: vi.fn(),
        onFailure: (_tabId, failure) => { failures.push(failure.error.code); },
      });
      const done = handle(7, captureMsg("https://ads.example/slow.m3u8"));
      // Far less than the time such a server could keep a check busy.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await done;
      expect(streams).toBeGreaterThan(0);
      expect(failures).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("lets go of everything that waits when the tab shows another page", async () => {
    const gate = gated();
    const onDescriptor = vi.fn();
    const handle = createCaptureHandler({ fetchFn: gate.fetchFn as never, onDescriptor });
    const all = Array.from({ length: 30 }, (_, n) => handle(7, captureMsg(`https://cdn.example/feed/${n}.mp4`)));
    await flush();
    handle.clearTab(7);
    await gate.release();
    await Promise.all(all);
    expect(gate.started()).toBe(MAX_FRAME_PROBES);
    expect(onDescriptor).not.toHaveBeenCalled();
  });
});
