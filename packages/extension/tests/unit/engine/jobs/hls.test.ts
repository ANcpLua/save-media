import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runHlsJob } from "../../../../src/engine/jobs/hls";
import type { JobSink } from "../../../../src/engine/sink";
import type { HlsPlainPlan, VariantId } from "@savemedia/core";
import { hlsDescriptor } from "../../popup/helpers/descriptors";

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

// AES-128 over fMP4: the init segment stays clear (RFC 8216), only the
// fragments are ciphertext, and the IV is declared so the test controls it.
const AES_FMP4_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXT-X-MAP:URI="init.mp4"
#EXTINF:10.0,
seg1.m4s
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

function box(type: string, payload = new Uint8Array()): Uint8Array {
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

class CapturingSink implements JobSink {
  openedFilename: string | null = null;
  expectedSize: number | null = null;
  writes: Uint8Array[] = [];
  aborted = false;

  async open(filename: string, expectedSize: number | null): Promise<void> {
    this.openedFilename = filename;
    this.expectedSize = expectedSize;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.writes.push(new Uint8Array(bytes));
  }

  async close(): Promise<{ blobUrl: string; filename: string; checksum: string }> {
    return {
      blobUrl: "blob:unit-test",
      filename: this.openedFilename ?? "",
      checksum: "",
    };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

describe("runHlsJob — supported plain VOD boundary", () => {
  it("fetches a fixed media playlist and attempts TS→MP4 remux instead of saving raw segments as .mp4", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      if (url.endsWith("seg1.ts")) return bytesResponse(new Uint8Array([0x47, 0x40, 0x00, 0x10]));
      if (url.endsWith("seg2.ts")) return bytesResponse(new Uint8Array([0x47, 0x40, 0x00, 0x11]));
      throw new Error(`unexpected ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toThrow(/unsupported|format/i);
  });

  it("rejects unknown segment bytes instead of trusting the URL extension", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      return bytesResponse(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "hls_layout_unsupported" });
  });

  it("refuses live/sliding-window playlists", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(LIVE_PLAYLIST);
      return bytesResponse(new Uint8Array([0x47]));
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
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

    const result = await runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal, sink);

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

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "license_bound_stream", httpStatus: 403 });
  });

  it("a key URI that answers with something other than 16 bytes is refused", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(AES_FMP4_PLAYLIST);
      if (url.endsWith("init.mp4")) return bytesResponse(FMP4_INIT_BYTES);
      if (url.endsWith("seg1.m4s")) return bytesResponse(new Uint8Array(32));
      if (url.endsWith("key.bin")) return bytesResponse(new Uint8Array(32));
      throw new Error(`should not fetch ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "license_bound_stream" });
  });

  it("refuses AES-128 behind a FairPlay KEYFORMAT without touching the key URI", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith(".m3u8")) return textResponse(FAIRPLAY_PLAYLIST);
      throw new Error(`should not fetch ${url}`);
    });
    patchFetch(fetch);

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "cdm_required", keySystem: "com.apple.streamingkeydelivery" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses SAMPLE-AES at runtime with cdm_required", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(SAMPLE_AES_PLAYLIST);
      throw new Error(`should not fetch ${url}`);
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
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

    const result = await runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal, sink);

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

  it("throws segment_budget_exhausted when a TS segment cannot be fetched", async () => {
    patchFetch(async url => {
      if (url.endsWith(".m3u8")) return textResponse(MEDIA_PLAYLIST);
      return new Response("not found", { status: 404 });
    });

    await expect(runHlsJob(plainPlan(), hlsDescriptor(), vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "segment_budget_exhausted" });
  });
});
