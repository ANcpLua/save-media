// @vitest-environment node
//
// Exercises the real merge (mediabunny) through the engine job, driven by a
// mocked fetch that serves committed ffmpeg fixtures and an injected sink.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { runAvMergeJob } from "../../../../src/engine/jobs/av-merge";
import { CapturingSink } from "../helpers/capturing-sink";
import type { TransferStage } from "../../../../src/engine/job";
import { initSegment } from "../helpers/iso-bmff";
import { noWaits, waitsOf } from "../../helpers/waits";
import type { AvMergePlan } from "@savemedia/core";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(process.cwd(), "tests/unit/engine/fixtures", name)));

const VIDEO_BYTES = fixture("video-only.mp4"); // H.264
const transportStream = new Uint8Array(readFileSync(resolve(process.cwd(), "tests/e2e/media-fixtures/transport/timed-id3.ts")));
const AUDIO_BYTES = fixture("audio-only.m4a"); // AAC

const VIDEO_URL = "https://cdn.example/video.mp4";
const AUDIO_URL = "https://cdn.example/audio.m4a";

function plan(): AvMergePlan {
  return {
    kind: "av-merge",
    video: { initUrl: null, segmentUrls: [VIDEO_URL] },
    audio: { initUrl: null, segmentUrls: [AUDIO_URL] },
    outputContainer: "mp4",
    outputFilename: "clip.bin",
    estimatedBytes: null,
  };
}

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function patchFetch(fetcher: (url: string) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => fetcher(String(url))) as unknown as typeof fetch;
}

describe("runAvMergeJob", () => {
  it("stops the merge when the user cancels during it: the job ends as cancelled and nothing is written", async () => {
    patchFetch(async url => new Response((url === VIDEO_URL ? VIDEO_BYTES : AUDIO_BYTES) as BodyInit, { status: 200 }));
    const controller = new AbortController();
    const sink = new CapturingSink();
    const merging: (number | null)[] = [];
    const run = runAvMergeJob(plan(), { signal: controller.signal, sink, onProgress: progress => {
      if (progress.stage.kind !== "merging") return;
      merging.push(progress.stage.fraction);
      // Cancel as the popup's button does, at the first word of the merge.
      if (merging.length === 2) controller.abort(new DOMException("user-cancelled", "AbortError"));
    } });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    // Without the cancel the merge reports every percent up to 1.
    expect(merging.length).toBe(2);
    expect(sink.filename).toBe("");
  });

  it("fetches both tracks, merges to one MP4 carrying video + audio, and normalises the extension", async () => {
    patchFetch(async url => {
      if (url === VIDEO_URL) return new Response(VIDEO_BYTES as BodyInit, { status: 200 });
      if (url === AUDIO_URL) return new Response(AUDIO_BYTES as BodyInit, { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const sink = new CapturingSink();

    const result = await runAvMergeJob(plan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });

    expect(result.filename).toBe("clip.mp4"); // .bin → .mp4
    const merged = sink.bytes();
    expect(String.fromCharCode(merged[4]!, merged[5]!, merged[6]!, merged[7]!)).toBe("ftyp");

    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(merged) });
    expect(await input.getPrimaryVideoTrack()).not.toBeNull();
    expect(await input.getPrimaryAudioTrack()).not.toBeNull();
  });

  // A packager's one-file tracks under HLS: each playlist names the header and the parts and leaves the file's index out.
  it("merges tracks that are one file each whose playlist's byte ranges leave the index out, and refuses a track whose ranges leave media out", async () => {
    const single = (name: string) => new Uint8Array(readFileSync(resolve(process.cwd(), "tests/e2e/media-fixtures/dash-single-file", name)));
    const video = single("clip-stream0.mp4");
    const audio = single("clip-stream1.mp4");
    patchFetch(async url => new Response((url === VIDEO_URL ? video : audio) as BodyInit, { status: 200 }));
    const withGaps = (videoGap: { offset: number; length: number }): AvMergePlan => ({ ...plan(),
      video: { initUrl: null, segmentUrls: [VIDEO_URL], fileBytes: video.length, fileGaps: [videoGap] },
      audio: { initUrl: null, segmentUrls: [AUDIO_URL], fileBytes: audio.length, fileGaps: [{ offset: 768, length: 64 }] } });
    const sink = new CapturingSink();
    await runAvMergeJob(withGaps({ offset: 810, length: 64 }), { onProgress: vi.fn(), signal: new AbortController().signal, sink });
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
    expect(await input.getPrimaryVideoTrack()).not.toBeNull();
    expect(await input.getPrimaryAudioTrack()).not.toBeNull();
    expect(await input.computeDuration()).toBeGreaterThan(1.9);

    // The stretch after the header now takes in the first fragment's header: media the playlist does not name.
    const refused = new CapturingSink();
    await expect(runAvMergeJob(withGaps({ offset: 810, length: 64 + 164 }), { onProgress: vi.fn(), signal: new AbortController().signal, sink: refused }))
      .rejects.toEqual({ code: "hls_layout_unsupported", severity: "terminal", manifestUrl: VIDEO_URL, layout: "byte-ranges" });
    expect(refused.writes).toHaveLength(0);
  });

  it("reports monotonic byte progress ending in a merging/finalizing stage", async () => {
    patchFetch(async url => new Response((url === VIDEO_URL ? VIDEO_BYTES : AUDIO_BYTES) as BodyInit, { status: 200 }));
    const stages: TransferStage[] = [];
    let last = -1;
    let monotonic = true;
    await runAvMergeJob(plan(), { onProgress: ({ stage, bytesWritten }) => {
      stages.push(stage);
      if (bytesWritten < last) monotonic = false;
      last = bytesWritten;
    }, signal: new AbortController().signal, sink: new CapturingSink() });

    expect(monotonic).toBe(true);
    expect(stages).toContainEqual({ kind: "track", track: "video" });
    expect(stages).toContainEqual({ kind: "track", track: "audio" });
    expect(stages.some(stage => stage.kind === "merging")).toBe(true);
    expect(stages.at(-1)).toEqual({ kind: "finalizing" });
  });

  it("saves a source with no audio track with its picture alone, and requests nothing else", async () => {
    const requested: string[] = [];
    patchFetch(async url => { requested.push(url); return new Response(VIDEO_BYTES as BodyInit, { status: 200 }); });
    const sink = new CapturingSink();
    const stages: TransferStage[] = [];
    const prepareRequests = vi.fn(async () => undefined);

    const result = await runAvMergeJob({ ...plan(), audio: null },
      { onProgress: ({ stage }) => stages.push(stage), signal: new AbortController().signal, sink, prepareRequests });

    expect(result.filename).toBe("clip.mp4");
    expect(requested).toEqual([VIDEO_URL]);
    expect(prepareRequests).toHaveBeenCalledWith([VIDEO_URL]);
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
    expect((await input.getPrimaryVideoTrack())?.codec).toBe("avc");
    expect(await input.getPrimaryAudioTrack()).toBeNull();
    expect(stages).not.toContainEqual({ kind: "track", track: "audio" });
    expect(stages.at(-1)).toEqual({ kind: "finalizing" });
  });

  it("joins a track's init section and segments in the manifest's order", async () => {
    // The fixture cut in three: an init section and two media parts, each under its own address.
    const cut = [0, 900, 4000, VIDEO_BYTES.length];
    const part = (index: number) => VIDEO_BYTES.slice(cut[index]!, cut[index + 1]!);
    const addresses = ["https://cdn.example/init.mp4", "https://cdn.example/1.m4s", "https://cdn.example/2.m4s"];
    patchFetch(async url => new Response((url === AUDIO_URL ? AUDIO_BYTES : part(addresses.indexOf(url))) as BodyInit));
    const sink = new CapturingSink();
    await runAvMergeJob({ ...plan(), video: { initUrl: addresses[0]!, segmentUrls: addresses.slice(1) } },
      { onProgress: vi.fn(), signal: new AbortController().signal, sink });
    const packets = async (bytes: Uint8Array) => {
      const track = await new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) }).getPrimaryVideoTrack();
      const sizes: number[] = [];
      for await (const packet of new EncodedPacketSink(track!).packets()) sizes.push(packet.data.byteLength);
      return sizes;
    };
    expect(await packets(sink.bytes())).toEqual(await packets(VIDEO_BYTES));
  });

  it("waits out an outage in the middle of a track and goes on with the segment it was reading", async () => {
    const waits = noWaits();
    const cut = [0, 900, 4000, VIDEO_BYTES.length];
    const part = (index: number) => VIDEO_BYTES.slice(cut[index]!, cut[index + 1]!);
    const addresses = ["https://cdn.example/init.mp4", "https://cdn.example/1.m4s", "https://cdn.example/2.m4s"];
    const requested: string[] = [];
    let outage = 7;
    patchFetch(async url => {
      requested.push(url);
      if (url === addresses[2] && outage-- > 0) throw new TypeError("Failed to fetch");
      return new Response((url === AUDIO_URL ? AUDIO_BYTES : part(addresses.indexOf(url))) as BodyInit);
    });
    const stages: [TransferStage, number][] = [];
    const sink = new CapturingSink();
    await runAvMergeJob({ ...plan(), video: { initUrl: addresses[0]!, segmentUrls: addresses.slice(1) } },
      { onProgress: ({ stage, bytesWritten }) => { stages.push([stage, bytesWritten]); }, signal: new AbortController().signal, sink });
    // What was received before the outage was asked for once, and the bytes held are told with the wait.
    expect(requested.filter(url => url === addresses[0] || url === addresses[1])).toEqual(addresses.slice(0, 2));
    expect(stages.filter(([stage]) => stage.kind === "reconnecting")).toEqual([[{ kind: "reconnecting", waitMs: 1000 }, 4000]]);
    expect(waitsOf(waits).filter(ms => ms === 1000)).toHaveLength(1);
    const track = await new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) }).getPrimaryVideoTrack();
    expect(track).not.toBeNull();
  });

  it("requests both tracks as the page's player does: page Referer prepared, cookies included", async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) =>
      new Response((url === VIDEO_URL ? VIDEO_BYTES : AUDIO_BYTES) as BodyInit, { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const prepareRequests = vi.fn(async () => {
      expect(fetchSpy).not.toHaveBeenCalled();
    });
    await runAvMergeJob(plan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink(), prepareRequests });
    expect(prepareRequests).toHaveBeenCalledWith([VIDEO_URL, AUDIO_URL]);
    expect(fetchSpy.mock.calls.map(([, init]) => init?.credentials)).toEqual(["include", "include"]);
  });

  it("fails with a terminal error when a segment cannot be fetched", async () => {
    patchFetch(async url => {
      if (url === VIDEO_URL) return new Response("not found", { status: 404 });
      return new Response(AUDIO_BYTES as BodyInit, { status: 200 });
    });

    await expect(runAvMergeJob(plan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink() }))
      .rejects.toMatchObject({ severity: "terminal" });
  });

  it("aborts before fetching when the signal is already aborted", async () => {
    patchFetch(async () => { throw new Error("should not fetch"); });
    const controller = new AbortController();
    controller.abort();

    await expect(runAvMergeJob(plan(), { onProgress: vi.fn(), signal: controller.signal, sink: new CapturingSink() }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a track whose init segment declares Common Encryption, before merging anything", async () => {
    patchFetch(async url => new Response((url === VIDEO_URL ? initSegment({ scheme: "cenc", pssh: true }) : AUDIO_BYTES) as BodyInit, { status: 200 }));
    const sink = new CapturingSink();
    await expect(runAvMergeJob(plan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink }))
      .rejects.toEqual({ code: "encrypted_media_detected", severity: "terminal", detectedVia: ["mp4-protection"], keySystem: "com.widevine.alpha" });
    expect(sink.writes).toHaveLength(0);
  });

  describe("HLS AES-128 tracks", () => {
    const KEY_URL = "https://keys.example/k.bin";
    const KEY = new Uint8Array(16).map((_, i) => i * 17);
    const IV = new Uint8Array(16).map((_, i) => 255 - i);
    async function encrypt(plain: Uint8Array): Promise<Uint8Array> {
      const key = await crypto.subtle.importKey("raw", KEY as unknown as ArrayBuffer, { name: "AES-CBC" }, false, ["encrypt"]);
      return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: IV as unknown as ArrayBuffer }, key, plain as unknown as ArrayBuffer));
    }
    const segmentKey = { keyUri: KEY_URL, iv: IV, mediaSequence: 0 };

    it.each([false, true])("decrypts each segment with the key its playlist names, fetched as the player does (in the init section=%s)", async inInit => {
      const encrypted = await encrypt(VIDEO_BYTES);
      const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url === KEY_URL) return new Response(KEY as BodyInit);
        return new Response((url === VIDEO_URL ? encrypted : AUDIO_BYTES) as BodyInit);
      });
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      const keyed: AvMergePlan = { ...plan(), video: inInit
        ? { initUrl: VIDEO_URL, segmentUrls: [], initKey: segmentKey, segmentKeys: [] }
        : { initUrl: null, segmentUrls: [VIDEO_URL], segmentKeys: [segmentKey] } };
      const prepareRequests = vi.fn(async () => undefined);
      const sink = new CapturingSink();
      await runAvMergeJob(keyed, { onProgress: vi.fn(), signal: new AbortController().signal, sink, prepareRequests });
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
      expect(await input.getPrimaryVideoTrack()).not.toBeNull();
      expect(await input.getPrimaryAudioTrack()).not.toBeNull();
      expect(prepareRequests).toHaveBeenCalledWith([KEY_URL, VIDEO_URL, AUDIO_URL]);
      expect(fetchSpy.mock.calls.find(([url]) => url === KEY_URL)?.[1]?.credentials).toBe("include");
    });

    it("refuses a key server that refuses the player's own request as licence bound", async () => {
      patchFetch(async url => url === KEY_URL ? new Response("no", { status: 403 })
        : new Response((url === VIDEO_URL ? await encrypt(VIDEO_BYTES) : AUDIO_BYTES) as BodyInit));
      const keyed: AvMergePlan = { ...plan(), video: { initUrl: null, segmentUrls: [VIDEO_URL], segmentKeys: [segmentKey] } };
      await expect(runAvMergeJob(keyed, { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink() }))
        .rejects.toEqual({ code: "license_bound_stream", severity: "terminal", keyUri: KEY_URL, httpStatus: 403 });
    });
  });

  it("refuses a transport-stream track whose packets are scrambled, before merging anything", async () => {
    const scrambled = transportStream.slice();
    scrambled[5 * 188 + 3] = scrambled[5 * 188 + 3]! | 0x80;
    patchFetch(async url => new Response((url === VIDEO_URL ? scrambled : AUDIO_BYTES) as BodyInit));
    const sink = new CapturingSink();
    await expect(runAvMergeJob(plan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink }))
      .rejects.toEqual({ code: "encrypted_media_detected", severity: "terminal", detectedVia: ["mpeg-ts"], keySystem: null });
    expect(sink.writes).toHaveLength(0);
  });

  it("names a page sent in place of a track instead of failing in the muxer", async () => {
    patchFetch(async url => new Response(url === VIDEO_URL ? "<html><body>Please sign in</body></html>" : AUDIO_BYTES as BodyInit));
    await expect(runAvMergeJob(plan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink() }))
      .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response: "page" });
  });

  describe("a track that is one file", () => {
    /** A body handed out in pieces of `size` bytes; `handed` counts the pieces a reader took. */
    function inPieces(bytes: Uint8Array, size: number): { readonly body: ReadableStream<Uint8Array>; handed: number; cancelled: boolean } {
      const state = { handed: 0, cancelled: false, body: undefined as unknown as ReadableStream<Uint8Array> };
      state.body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const start = state.handed * size;
          if (start >= bytes.length) { controller.close(); return; }
          state.handed += 1;
          controller.enqueue(bytes.slice(start, start + size));
        },
        cancel() { state.cancelled = true; },
      }, { highWaterMark: 0 });
      return state;
    }

    it("is merged from a body that arrives in many small pieces, with the bytes counted as they arrive", async () => {
      patchFetch(async url => new Response(inPieces(url === VIDEO_URL ? VIDEO_BYTES : AUDIO_BYTES, 97).body));
      const sink = new CapturingSink();
      const written: number[] = [];
      await runAvMergeJob(plan(), { onProgress: ({ bytesWritten }) => written.push(bytesWritten), signal: new AbortController().signal, sink });
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
      expect(await input.getPrimaryVideoTrack()).not.toBeNull();
      expect(await input.getPrimaryAudioTrack()).not.toBeNull();
      expect(written).toContain(VIDEO_BYTES.length);
      expect(written).toContain(VIDEO_BYTES.length + AUDIO_BYTES.length);
      expect([...written].sort((a, b) => a - b)).toEqual(written);
    });

    it("refuses a page in its place from the first bytes, and reads no further", async () => {
      const page = new TextEncoder().encode(`<html><body>${"Please sign in. ".repeat(4000)}</body></html>`);
      const served = inPieces(page, 1024);
      patchFetch(async url => new Response(url === VIDEO_URL ? served.body : AUDIO_BYTES as BodyInit));
      await expect(runAvMergeJob(plan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink() }))
        .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response: "page" });
      expect(served.handed).toBeLessThanOrEqual(5);
      expect(served.cancelled).toBe(true);
    });

    it("refuses Common Encryption declared after the media, before merging anything", async () => {
      const encrypted = initSegment({ scheme: "cenc" });
      const fileType = encrypted.subarray(0, new DataView(encrypted.buffer).getUint32(0));
      const mediaData = new Uint8Array(6008);
      new DataView(mediaData.buffer).setUint32(0, mediaData.length);
      mediaData.set([0x6d, 0x64, 0x61, 0x74], 4);
      const movieLast = new Uint8Array([...fileType, ...mediaData, ...encrypted.subarray(fileType.length)]);
      patchFetch(async url => new Response(url === VIDEO_URL ? inPieces(movieLast, 512).body : AUDIO_BYTES as BodyInit));
      const sink = new CapturingSink();
      await expect(runAvMergeJob(plan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink }))
        .rejects.toEqual({ code: "encrypted_media_detected", severity: "terminal", detectedVia: ["mp4-protection"], keySystem: "cenc" });
      expect(sink.writes).toHaveLength(0);
    });

    it("reads the file again from its start when the body drops, and merges it once", async () => {
      noWaits();
      let attempts = 0;
      patchFetch(async url => {
        if (url !== VIDEO_URL) return new Response(AUDIO_BYTES as BodyInit);
        attempts += 1;
        if (attempts > 1) return new Response(inPieces(VIDEO_BYTES, 1000).body);
        let handed = false;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (handed) { controller.error(new TypeError("network error")); return; }
            handed = true;
            controller.enqueue(VIDEO_BYTES.slice(0, 5000));
          },
        }));
      });
      const sink = new CapturingSink();
      await runAvMergeJob({ ...plan(), audio: null }, { onProgress: vi.fn(), signal: new AbortController().signal, sink });
      expect(attempts).toBe(2);
      const track = await new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) }).getPrimaryVideoTrack();
      const source = await new Input({ formats: ALL_FORMATS, source: new BufferSource(VIDEO_BYTES) }).getPrimaryVideoTrack();
      const count = async (of: typeof track) => { let n = 0; for await (const _ of new EncodedPacketSink(of!).packets()) n += 1; return n; };
      expect(await count(track)).toBe(await count(source));
    });
  });

  // HLS packed audio (RFC 8216 section 3.4): bare AAC frames, each segment opening with an ID3 tag.
  // The fixture comes from scripts/generate-packed-audio-fixtures.mjs.
  describe("an audio rendition of bare audio frames", () => {
    const packed = (name: string) => new Uint8Array(readFileSync(resolve(process.cwd(), "tests/e2e/media-fixtures/hls-packed-audio", name)));
    const BASE = "https://cdn.example/packed/";
    const VIDEO = ["v007.ts", "v008.ts", "v009.ts"];
    const AUDIO = ["a007.aac", "a008.aac", "a009.aac"];
    const packedPlan = (): AvMergePlan => ({ ...plan(),
      video: { initUrl: null, segmentUrls: VIDEO.map(name => BASE + name) },
      audio: { initUrl: null, segmentUrls: AUDIO.map(name => BASE + name) } });
    const track = async (bytes: Uint8Array, kind: "video" | "audio") => {
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
      const of = kind === "video" ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
      const sizes: number[] = [];
      let first: number | null = null;
      let end = 0;
      for await (const packet of new EncodedPacketSink(of!).packets()) {
        sizes.push(packet.data.byteLength);
        first ??= packet.timestamp;
        end = packet.timestamp + packet.duration;
      }
      return { codec: of!.codec, sizes, first: first!, end };
    };

    it("is saved whole: every frame of every segment, not only the first segment's", async () => {
      patchFetch(async url => new Response(packed(url.slice(BASE.length)) as BodyInit));
      const sink = new CapturingSink();
      await runAvMergeJob(packedPlan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });

      const source = await track(packed("reference-audio.aac"), "audio");
      const saved = await track(sink.bytes(), "audio");
      expect(source.sizes.length).toBe(131);
      expect(saved.codec).toBe("aac");
      // An MP4 stores each AAC frame without the seven header bytes it has in ADTS.
      expect(saved.sizes).toEqual(source.sizes.map(size => size - 7));
      // The sound is as long as the picture, and starts where the picture starts: the first tag's time.
      const picture = await track(sink.bytes(), "video");
      expect(picture.sizes.length).toBe(45);
      expect(saved.first).toBeCloseTo(picture.first, 2);
      expect(Math.abs(saved.end - picture.end)).toBeLessThan(0.1);
    });

    it("refuses a segment that holds something else than tags and audio frames, and saves nothing", async () => {
      patchFetch(async url => url.endsWith("a008.aac")
        ? new Response(new Uint8Array([...packed("a008.aac").slice(0, 400), ...new Uint8Array(64)]) as BodyInit)
        : new Response(packed(url.slice(BASE.length)) as BodyInit));
      const sink = new CapturingSink();
      await expect(runAvMergeJob(packedPlan(), { onProgress: vi.fn(), signal: new AbortController().signal, sink }))
        .rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response: "unsupported", host: "cdn.example" });
      expect(sink.writes).toEqual([]);
    });
  });

  it("rejects a track with no segments", async () => {
    patchFetch(async () => new Response(AUDIO_BYTES as BodyInit, { status: 200 }));
    const empty: AvMergePlan = { ...plan(), video: { initUrl: null, segmentUrls: [] } };

    await expect(runAvMergeJob(empty, { onProgress: vi.fn(), signal: new AbortController().signal, sink: new CapturingSink() }))
      .rejects.toMatchObject({ code: "manifest_malformed" });
  });
});
