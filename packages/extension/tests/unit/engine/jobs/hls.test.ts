import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runHlsJob } from "../../../../src/engine/jobs/hls";
import { CapturingSink } from "../helpers/capturing-sink";
import type { HlsPlainPlan, VariantId } from "@savemedia/core";
import { hlsDescriptor } from "../../popup/helpers/descriptors";
import { initSegment } from "../helpers/iso-bmff";
import { noWaits, waitsOf } from "../../helpers/waits";
import type { TransferStage } from "../../../../src/engine/job";

function plainPlan(): HlsPlainPlan {
  return {
    kind: "hls-plain",
    steps: [],
    outputContainer: "mp4",
    outputFilename: "out.mp4",
    variantId: "v-1080" as VariantId,
    estimatedBytes: null,
  };
}

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
seg1.ts
#EXTINF:10.0,
seg2.ts
#EXT-X-ENDLIST
`;

const LIVE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:33
#EXTINF:10.0,
seg33.ts
`;

const SAMPLE_AES_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://x/license"
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;

const FMP4_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.0,
seg1.m4s
#EXT-X-ENDLIST
`;

// AES-128 over fMP4 with the key declared before EXT-X-MAP, which covers the
// init section too (RFC 8216 4.3.2.4); packagers send that section clear or
// encrypted. The IV is declared so the test controls it.
const AES_FMP4_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.0,
seg1.m4s
#EXT-X-ENDLIST
`;

// AES-128 over MPEG-TS with a declared IV.
const AES_TS_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;

// METHOD=AES-128, but the key lives behind a CDM: refuse, never fetch.
const FAIRPLAY_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:5
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="skd://keys.test/fp",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:10.0,
seg1.ts
#EXT-X-ENDLIST
`;

const AES_KEY_BYTES = new Uint8Array([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
]);
const AES_IV_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

async function encryptForFixture(plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", AES_KEY_BYTES as unknown as ArrayBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: AES_IV_BYTES as unknown as ArrayBuffer },
    key,
    plaintext as unknown as ArrayBuffer,
  );
  return new Uint8Array(cipher);
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function bytesResponse(payload: Uint8Array): Response {
  return new Response(payload as BodyInit, { status: 200 });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

function patchFetch(fetcher: (url: string) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => fetcher(String(url))) as unknown as typeof fetch;
}

function box(type: string, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength);
  out.set([...type].map(c => c.charCodeAt(0)), 4);
  out.set(payload, 8);
  return out;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const FMP4_INIT_BYTES = concatBytes([
  box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d])),
  box("moov"),
]);

const FMP4_FRAGMENT_BYTES = concatBytes([
  box("moof"),
  box("mdat", new Uint8Array([0x01, 0x02, 0x03])),
]);

describe("runHlsJob — supported plain VOD boundary", () => {
  it("retries only the interrupted media segment without reloading the playlist or init segment", async () => {
    const requested: string[] = [];
    const init = concatBytes([box("ftyp"), box("moov")]);
    const segment = concatBytes([box("moof"), box("mdat", new Uint8Array([23, 45]))]);
    let attempts = 0;
    const waits = noWaits();
    patchFetch(async url => {
      const name = url.split("/").at(-1)!;
      requested.push(name);
      if (name.endsWith(".m3u8")) return textResponse(FMP4_MEDIA_PLAYLIST);
      if (name === "init.mp4") return bytesResponse(init);
      return new Response(new Uint8Array(++attempts === 1 ? segment.slice(0, 5) : segment), {headers: {"content-length": String(segment.length)}});
    });
    const sink = new CapturingSink();
    await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });
    expect(requested.filter(url => url.endsWith(".m3u8"))).toHaveLength(1);
    expect(requested.slice(1)).toEqual(["init.mp4", "seg1.m4s", "seg1.m4s"]);
    // One wait before the one repeat: the policy's, never the test's own time.
    expect(waits).toHaveBeenCalledTimes(1);
    expect(sink.writes).toEqual([init, segment]);
  });

  it("rejects a stream whose segments hold no whole transport packet before creating output", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      if (url.endsWith("seg1.ts")) return bytesResponse(new Uint8Array([0x47, 0x40, 0x00, 0x10]));
      if (url.endsWith("seg2.ts")) return bytesResponse(new Uint8Array([0x47, 0x40, 0x00, 0x11]));
      throw new Error(`unexpected ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "verification_container", probeError: "Missing MPEG-TS program map" });
  });

  it("rejects unknown segment bytes instead of trusting the URL extension, naming the playlist and not the segment", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      return bytesResponse(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toEqual({ code: "hls_layout_unsupported", severity: "terminal", manifestUrl: "https://example.com/master.m3u8", layout: "not-transport-stream" });
  });

  it.each([
    ["page", "<!doctype html><html><body>Sign in to continue</body></html>"],
    ["data", JSON.stringify({ error: "token expired" })],
  ] as const)("names a %s sent in place of a segment, clear or AES-128, instead of a layout or encryption problem", async (response, body) => {
    for (const playlist of [MEDIA_PLAYLIST, AES_TS_PLAYLIST]) {
      patchFetch(async url => {
        if (url.endsWith(".m3u8")) return textResponse(playlist);
        if (url.endsWith("key.bin")) return bytesResponse(AES_KEY_BYTES);
        return new Response(body, { status: 200, headers: { "content-type": "video/mp2t" } });
      });
      await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
        .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response });
    }
  });

  it("says a 16-byte key that does not decrypt the segments is the wrong key, not an unsupported layout", async () => {
    const segment = await encryptForFixture(new Uint8Array(4 * 188).fill(0x47));
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(AES_TS_PLAYLIST);
      if (url.endsWith("key.bin")) return bytesResponse(new Uint8Array(16).fill(7));
      return bytesResponse(segment);
    });
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toEqual({ code: "hls_key_unusable", severity: "terminal", keyUri: "https://example.com/key.bin", response: "rejected", byteLength: 16 });
  });

  it("decrypts an init section an AES-128 key covers, and uses a clear one as it is", async () => {
    const playlist = AES_FMP4_PLAYLIST;
    for (const encryptedInit of [true, false]) {
      const media = box("moof", new Uint8Array(box("mfhd", new Uint8Array(8))));
      const fragment = new Uint8Array([...media, ...box("mdat", new Uint8Array([1, 2, 3, 4]))]);
      const init: Uint8Array = encryptedInit ? await encryptForFixture(new Uint8Array(FMP4_INIT_BYTES)) : FMP4_INIT_BYTES;
      const encryptedFragment = await encryptForFixture(fragment);
      patchFetch(async url => {
        if (url.endsWith(".m3u8")) return textResponse(playlist);
        if (url.endsWith("key.bin")) return bytesResponse(AES_KEY_BYTES);
        if (url.endsWith("init.mp4")) return bytesResponse(init);
        if (url.endsWith("seg1.m4s")) return bytesResponse(encryptedFragment);
        throw new Error(`should not fetch ${url}`);
      });
      const sink = new CapturingSink();
      await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });
      expect(concatBytes(sink.writes)).toEqual(new Uint8Array([...FMP4_INIT_BYTES, ...fragment]));
    }
  });

  it("names network failures inside a segment body as a lost connection, not as a missing segment", async () => {
    noWaits();
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(new Uint8Array(188).fill(0x47)); }
          else controller.error(new TypeError("network changed"));
        },
      }, { highWaterMark: 0 }), { status: 200 });
    });
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "network_unreachable", phase: "segment", during: "transfer" });
  });

  // A connection that drops for a while, late in a stream of many parts: the parts already received are kept.
  const THREE_PARTS = FMP4_MEDIA_PLAYLIST.replace("seg1.m4s\n", "seg1.m4s\n#EXTINF:10.0,\nseg2.m4s\n#EXTINF:10.0,\nseg3.m4s\n");
  const part = (n: number) => concatBytes([box("moof"), box("mdat", new Uint8Array([n, n, n]))]);

  it("waits out an outage in the middle of a stream and goes on with the part it was reading, keeping the parts it has", async () => {
    const waits = noWaits();
    const requested: string[] = [];
    let outage = 12;
    patchFetch(async url => {
      const name = url.split("/").at(-1)!;
      requested.push(name);
      if (name.endsWith(".m3u8")) return textResponse(THREE_PARTS);
      if (name === "init.mp4") return bytesResponse(FMP4_INIT_BYTES);
      // No answer at all for the second part, for longer than the request's own quick retries last.
      if (name === "seg2.m4s" && outage-- > 0) throw new TypeError("Failed to fetch");
      return bytesResponse(part(Number(name[3])));
    });
    const stages: [TransferStage, number][] = [];
    const sink = new CapturingSink();
    const result = await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: ({ stage, bytesWritten }) => { stages.push([stage, bytesWritten]); },
      signal: new AbortController().signal, sink });
    expect(result.filename).toBe("out.mp4");
    // The whole stream, each part once and in order.
    expect(sink.writes).toEqual([FMP4_INIT_BYTES, part(1), part(2), part(3)]);
    // The playlist, the header and the first part were asked for once: nothing started again.
    for (const name of ["init.mp4", "seg1.m4s", "seg3.m4s"]) expect(requested.filter(item => item === name), name).toHaveLength(1);
    expect(requested.filter(item => item.endsWith(".m3u8"))).toHaveLength(1);
    expect(requested.filter(item => item === "seg2.m4s")).toHaveLength(13);
    // Two reconnects, after 1 and 2 seconds, said to the user with the bytes already held.
    const held = FMP4_INIT_BYTES.byteLength + part(1).byteLength;
    expect(stages.filter(([stage]) => stage.kind === "reconnecting")).toEqual([[{ kind: "reconnecting", waitMs: 1000 }, held], [{ kind: "reconnecting", waitMs: 2000 }, held]]);
    expect(waitsOf(waits).filter(ms => ms === 1000 || ms === 2000)).toEqual([1000, 2000]);
    expect(sink.aborted).toBe(false);
  });

  it("ends a save whose outage outlasts the reconnects as a lost connection, in both kinds of stream", async () => {
    // One transport stream packet that carries nothing (the null packet), clear.
    const packet = new Uint8Array(188).fill(0xff);
    packet.set([0x47, 0x1f, 0xff, 0x10]);
    for (const [playlist, first] of [[THREE_PARTS, part(1)], [MEDIA_PLAYLIST, packet]] as const) {
      const waits = noWaits();
      const requested: string[] = [];
      patchFetch(async url => {
        const name = url.split("/").at(-1)!;
        requested.push(name);
        if (name.endsWith(".m3u8")) return textResponse(playlist);
        if (name === "init.mp4") return bytesResponse(FMP4_INIT_BYTES);
        if (name.startsWith("seg1")) return bytesResponse(first);
        throw new TypeError("Failed to fetch");
      });
      const sink = new CapturingSink();
      await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink }))
        .rejects.toMatchObject({ code: "network_unreachable", phase: "segment", during: "request" });
      // Five reconnects, each after a longer wait, and then no more requests.
      expect(waitsOf(waits).filter(ms => ms >= 1000 && ms % 1000 === 0)).toEqual([1000, 2000, 4000, 8000, 16_000]);
      expect(requested.filter(name => name.startsWith("seg2"))).toHaveLength(6 * 5);
      expect(requested.filter(name => name.startsWith("seg3"))).toHaveLength(0);
      waits.mockRestore();
    }
  });

  it("does not wait for a part the server says it does not have", async () => {
    const waits = noWaits();
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(THREE_PARTS);
      if (url.endsWith("init.mp4")) return bytesResponse(FMP4_INIT_BYTES);
      return url.endsWith("seg1.m4s") ? bytesResponse(part(1)) : new Response("gone", { status: 410 });
    });
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink() }))
      .rejects.toMatchObject({ code: "http_error", httpStatus: 410, phase: "segment" });
    expect(waits).not.toHaveBeenCalled();
  });

  it("reports a playlist without variants as a playlist problem, not a quality minimum", async () => {
    const fetchSpy = vi.fn();
    patchFetch(fetchSpy);

    await expect(runHlsJob(plainPlan(), hlsDescriptor({ variants: [] }), { onProgress: vi.fn(), signal: new AbortController().signal })).rejects.toEqual({
      code: "manifest_malformed", severity: "terminal", url: "https://example.com/master.m3u8",
      parserError: "selected variant not in manifest",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses live/sliding-window playlists", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(LIVE_PLAYLIST);
      return bytesResponse(new Uint8Array([0x47]));
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "hls_live_unsupported" });
  });

  it("decrypts AES-128 fragments and writes the plaintext, nothing else", async () => {
    const ciphertext = await encryptForFixture(FMP4_FRAGMENT_BYTES);
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith(".m3u8")) return textResponse(AES_FMP4_PLAYLIST);
      if (url.endsWith("key.bin")) return bytesResponse(AES_KEY_BYTES);
      if (url.endsWith("init.mp4")) return bytesResponse(FMP4_INIT_BYTES);
      if (url.endsWith("seg1.m4s")) return bytesResponse(ciphertext);
      throw new Error(`should not fetch ${url}`);
    });
    patchFetch(fetch);
    const sink = new CapturingSink();

    const result = await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });

    expect(result.filename).toBe("out.mp4");
    expect(sink.aborted).toBe(false);
    // The decrypted fragment, byte for byte — not the ciphertext, and with
    // the PKCS#7 padding removed.
    expect(concatBytes(sink.writes)).toEqual(concatBytes([FMP4_INIT_BYTES, FMP4_FRAGMENT_BYTES]));
    // The key is fetched once, when the first ciphertext segment needs it.
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      "https://example.com/master.m3u8",
      "https://example.com/init.mp4",
      "https://example.com/seg1.m4s",
      "https://example.com/key.bin",
    ]);
  });

  it("a key URI that answers 403 is a licence server: license_bound_stream", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(AES_FMP4_PLAYLIST);
      if (url.endsWith("init.mp4")) return bytesResponse(FMP4_INIT_BYTES);
      if (url.endsWith("seg1.m4s")) return bytesResponse(new Uint8Array(32));
      if (url.endsWith("key.bin")) return new Response("forbidden", { status: 403 });
      throw new Error(`should not fetch ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "license_bound_stream", httpStatus: 403 });
  });

  it("a key URI that answers with something other than 16 bytes is not a key, and never a guess at DRM", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(AES_FMP4_PLAYLIST);
      if (url.endsWith("init.mp4")) return bytesResponse(FMP4_INIT_BYTES);
      if (url.endsWith("seg1.m4s")) return bytesResponse(new Uint8Array(32));
      if (url.endsWith("key.bin")) return bytesResponse(new Uint8Array(32));
      throw new Error(`should not fetch ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toEqual({ code: "hls_key_unusable", severity: "terminal", keyUri: "https://example.com/key.bin", response: "binary", byteLength: 32 });
  });

  it("a key URI that answers with a sign-in page is reported as a page, not as a licence server", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(AES_FMP4_PLAYLIST);
      if (url.endsWith("init.mp4")) return bytesResponse(FMP4_INIT_BYTES);
      if (url.endsWith("seg1.m4s")) return bytesResponse(new Uint8Array(32));
      if (url.endsWith("key.bin")) return new Response("<!doctype html><title>Sign in</title>", { headers: { "content-type": "text/html" } });
      throw new Error(`should not fetch ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "hls_key_unusable", response: "page" });
  });

  it("requests the key and segments as the page's player does: cookies included, the page's Referer prepared first", async () => {
    const ciphertext = await encryptForFixture(FMP4_FRAGMENT_BYTES);
    const order: string[] = [];
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      order.push(url.split("/").at(-1)!);
      expect(init?.credentials).toBe("include");
      if (url.endsWith(".m3u8")) return textResponse(AES_FMP4_PLAYLIST.replace('URI="key.bin"', 'URI="https://keys.example/key.bin"'));
      if (url.endsWith("key.bin")) return bytesResponse(AES_KEY_BYTES);
      if (url.endsWith("init.mp4")) return bytesResponse(FMP4_INIT_BYTES);
      return bytesResponse(ciphertext);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const prepareRequests = vi.fn(async (urls: readonly string[]) => { order.push(`prepare:${urls.length}`); });
    const sink = new CapturingSink();

    await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink, prepareRequests });

    expect(prepareRequests.mock.calls).toEqual([[["https://example.com/master.m3u8"]],
      [["https://keys.example/key.bin", "https://example.com/init.mp4", "https://example.com/seg1.m4s"]]]);
    expect(order).toEqual(["prepare:1", "master.m3u8", "prepare:3", "init.mp4", "seg1.m4s", "key.bin"]);
    expect(concatBytes(sink.writes)).toEqual(concatBytes([FMP4_INIT_BYTES, FMP4_FRAGMENT_BYTES]));
  });

  it("refuses a CENC or cbcs init segment as encrypted media and writes nothing", async () => {
    for (const scheme of ["cenc", "cbcs"] as const) {
      patchFetch(async url => {
        if (url.endsWith(".m3u8")) return textResponse(FMP4_MEDIA_PLAYLIST);
        if (url.endsWith("init.mp4")) return bytesResponse(initSegment({ scheme }));
        throw new Error(`should not fetch ${url}`);
      });
      const sink = new CapturingSink();
      await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink }))
        .rejects.toEqual({ code: "encrypted_media_detected", severity: "terminal", detectedVia: ["mp4-protection"], keySystem: scheme });
      expect(sink.writes).toHaveLength(0);
    }
  });

  it("refuses AES-128 behind a FairPlay KEYFORMAT without touching the key URI", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith(".m3u8")) return textResponse(FAIRPLAY_PLAYLIST);
      throw new Error(`should not fetch ${url}`);
    });
    patchFetch(fetch);

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "cdm_required", keySystem: "com.apple.streamingkeydelivery" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses SAMPLE-AES at runtime with cdm_required", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(SAMPLE_AES_PLAYLIST);
      throw new Error(`should not fetch ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "cdm_required", keySystem: "SAMPLE-AES" });
  });

  it("downloads clear HLS fMP4/CMAF only after validating init and fragment boxes", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith(".m3u8")) return textResponse(FMP4_MEDIA_PLAYLIST);
      if (url.endsWith("init.mp4")) return bytesResponse(FMP4_INIT_BYTES);
      if (url.endsWith("seg1.m4s")) return bytesResponse(FMP4_FRAGMENT_BYTES);
      throw new Error(`should not fetch ${url}`);
    });
    patchFetch(fetch);
    const sink = new CapturingSink();

    const result = await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });

    expect(result.filename).toBe("out.mp4");
    expect(sink.openedFilename).toBe("out.mp4");
    expect(sink.aborted).toBe(false);
    expect(concatBytes(sink.writes)).toEqual(concatBytes([FMP4_INIT_BYTES, FMP4_FRAGMENT_BYTES]));
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      "https://example.com/master.m3u8",
      "https://example.com/init.mp4",
      "https://example.com/seg1.m4s",
    ]);
  });

  // A master playlist states BANDWIDTH, the peak rate, and no length. That rate over the media playlist's
  // length leans high, so it is no size the stream states: a long stream that would fit must not be refused on it.
  it("never refuses a stream on its bit rate and length: the first segment is requested whatever they add up to", async () => {
    const long = (segments: number, map = "") => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n${map}${"#EXTINF:6.0,\nseg.ts\n".repeat(segments)}#EXT-X-ENDLIST\n`;
    const requested: string[] = [];
    const serve = (playlist: string) => patchFetch(async url => {
      requested.push(url.split("/").at(-1)!);
      return url.endsWith(".m3u8") ? textResponse(playlist) : new Response("not found", { status: 404 });
    });
    const variant = hlsDescriptor().variants[0]!;
    const sized = (bitrate: number | null) => hlsDescriptor({ variants: [{ ...variant, bitrate }] });
    const run = (bitrate: number | null) => runHlsJob(plainPlan(), sized(bitrate), { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink() });
    // 2 h 15 min at a peak of 2.2 Mbit/s adds up to 2.2 GB and is 1.4 GB at its average rate; three hours at
    // 6 Mbit/s adds up to 8.1 GB. Neither sum is a size: both go on to the first request after the playlist.
    for (const [bitrate, segments, first] of [[2_200_000, 1350, "seg.ts"], [6_000_000, 1800, "seg.ts"], [6_000_000, 1800, "init.mp4"], [null, 1800, "seg.ts"]] as const) {
      requested.length = 0;
      serve(long(segments, first === "init.mp4" ? '#EXT-X-MAP:URI="init.mp4"\n' : ""));
      await expect(run(bitrate)).rejects.toMatchObject({ code: "http_error", httpStatus: 404, phase: "segment" });
      expect(requested).toEqual(["master.m3u8", first]);
    }
  });

  it("refuses a stream whose playlist states a size that will not fit, with that size, before any key or segment is requested", async () => {
    // Byte ranges of one file state where the stream ends: 1.5 GiB twice.
    const part = 1_610_612_736;
    const playlist = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:6", "#EXTINF:6.0,", `#EXT-X-BYTERANGE:${part}@0`, "clip.ts",
      "#EXTINF:6.0,", `#EXT-X-BYTERANGE:${part}`, "clip.ts", "#EXT-X-ENDLIST", ""].join("\n");
    const requested: string[] = [];
    patchFetch(async url => {
      requested.push(url.split("/").at(-1)!);
      return url.endsWith(".m3u8") ? textResponse(playlist) : new Response("not found", { status: 404 });
    });
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink() }))
      .rejects.toEqual({ code: "output_too_large_for_browser", severity: "terminal", estimatedBytes: 2 * part, limitBytes: 2 * 1024 ** 3 });
    expect(requested).toEqual(["master.m3u8"]);
  });

  // A session that ended while the tab stayed open: the playlist's address now sends the sign-in page, with status 200.
  it("says a playlist address that sends a web page or other data as the save starts is no playlist any more, not a damaged or a live one", async () => {
    const requested: string[] = [];
    for (const [answer, response] of [["<!doctype html><html><body>Please sign in</body></html>", "page"], ['{"error":"session ended"}', "data"]] as const) {
      requested.length = 0;
      patchFetch(async url => { requested.push(url); return textResponse(answer); });
      await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
        .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response, host: "example.com", atSaveStart: true });
      expect(requested).toEqual(["https://example.com/master.m3u8"]);
    }
    // A playlist that is one and lists nothing stays a playlist that cannot be used.
    patchFetch(async () => textResponse("\uFEFF#EXTM3U\n#EXT-X-ENDLIST\n"));
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "manifest_malformed" });
  });

  // An inserted clip with a header of its own: its parts behind the first header would be saved as a file that stops playing there.
  it("refuses a fragmented MP4 playlist that changes its header part-way, before the header or a part is requested", async () => {
    const changing = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="ad/init.mp4"
#EXTINF:4.0,
ad/seg0.m4s
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="main/init.mp4"
#EXTINF:4.0,
main/seg0.m4s
#EXT-X-ENDLIST
`;
    const requested: string[] = [];
    patchFetch(async url => { requested.push(url.split("/").at(-1)!); return textResponse(changing); });
    const sink = new CapturingSink();
    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink }))
      .rejects.toEqual({ code: "hls_layout_unsupported", severity: "terminal", manifestUrl: "https://example.com/master.m3u8", layout: "init-changes" });
    expect(requested).toEqual(["master.m3u8"]);
    expect(sink.writes).toEqual([]);

    // The same header named again after a discontinuity is one header: the stream is saved.
    const repeated = changing.replace('URI="main/init.mp4"', 'URI="ad/init.mp4"');
    patchFetch(async url => url.endsWith(".m3u8") ? textResponse(repeated) : bytesResponse(url.endsWith("init.mp4") ? FMP4_INIT_BYTES : FMP4_FRAGMENT_BYTES));
    const saved = new CapturingSink();
    await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink: saved });
    expect(concatBytes(saved.writes)).toEqual(concatBytes([FMP4_INIT_BYTES, FMP4_FRAGMENT_BYTES, FMP4_FRAGMENT_BYTES]));
  });

  it("keeps the HTTP status of a missing TS segment", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      return new Response("not found", { status: 404 });
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "http_error", httpStatus: 404, phase: "segment" });
  });

  it("says a playlist the server refuses as the save starts was read again, and never says so about a segment", async () => {
    patchFetch(async () => new Response("gone", { status: 410 }));
    const failure = await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }).catch(error => error);
    expect(failure).toMatchObject({ code: "http_error", httpStatus: 410, phase: "manifest", atSaveStart: true });

    patchFetch(async url => url.endsWith(".m3u8") ? textResponse(MEDIA_PLAYLIST) : new Response("no", { status: 403 }));
    const segment = await runHlsJob(plainPlan(), hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal }).catch(error => error);
    expect(segment).toMatchObject({ code: "access_denied", phase: "segment" });
    expect("atSaveStart" in segment).toBe(false);
  });
});
