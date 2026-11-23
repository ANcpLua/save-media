// @vitest-environment node
//
// The MPEG-TS output rule through the real remux: an MP4 whenever it can carry
// the audio and video, the original packets only when it cannot.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import type { HlsPlainPlan, VariantId } from "@savemedia/core";
import { runHlsJob } from "../../../../src/engine/jobs/hls";
import { CapturingSink } from "../helpers/capturing-sink";
import { hlsDescriptor } from "../../popup/helpers/descriptors";
import { replaceStreamType, withProgramMap } from "../helpers/transport";

const timedId3 = new Uint8Array(readFileSync(resolve(__dirname, "../../../e2e/media-fixtures/transport/timed-id3.ts")));
const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg.ts\n#EXT-X-ENDLIST\n";
const plan: HlsPlainPlan = { kind: "hls-plain", steps: [], outputContainer: "mp4", outputFilename: "clip.mp4",
  variantId: "v-1080" as VariantId, estimatedBytes: null };

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const fixture = (path: string) => new Uint8Array(readFileSync(resolve(__dirname, "../../../e2e/media-fixtures", path)));

async function save(segment: Uint8Array, onProgress: (progress: { readonly stage: { readonly kind: string } }) => void = vi.fn()): Promise<CapturingSink> {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) =>
    new Response(String(url).endsWith(".m3u8") ? playlist : segment as BodyInit)) as unknown as typeof fetch;
  const sink = new CapturingSink();
  await runHlsJob(plan, hlsDescriptor(), { onProgress, signal: new AbortController().signal, sink });
  return sink;
}

describe("HLS transport stream output", () => {
  it("remuxes H.264 and AAC to MP4 and leaves the timed ID3 metadata out", async () => {
    const sink = await save(timedId3);
    expect(sink.filename).toBe("clip.mp4");
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
    expect(await input.getFormat()).toMatchObject({ name: "MP4" });
    expect((await input.getPrimaryVideoTrack())?.codec).toBe("avc");
    expect((await input.getPrimaryAudioTrack())?.codec).toBe("aac");
  });

  it("keeps the original packets when the program declares a stream an MP4 cannot carry", async () => {
    const unknown = withProgramMap(timedId3, replaceStreamType(0x0f, 0x90));
    const stages: string[] = [];
    const sink = await save(unknown, progress => { stages.push(progress.stage.kind); });
    expect(sink.filename).toBe("clip.ts");
    expect(sink.bytes()).toEqual(unknown);
    // Known from the program map: no remux is tried.
    expect(stages).not.toContain("remuxing");
  });

  it.each([
    ["AC-3 as ATSC declares it (stream type 0x81)", "transport/h264-ac3.ts", "ac3"],
    ["E-AC-3 as DVB declares it (private data with a descriptor)", "transport/h264-eac3.ts", "eac3"],
  ] as const)("remuxes H.264 with %s to an MP4 with its picture and its sound", async (_name, path, codec) => {
    const sink = await save(fixture(path));
    expect(sink.filename).toBe("clip.mp4");
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
    expect(await input.getFormat()).toMatchObject({ name: "MP4" });
    expect((await input.getPrimaryVideoTrack())?.codec).toBe("avc");
    const audio = await input.getPrimaryAudioTrack();
    expect(audio?.codec).toBe(codec);
    expect(await audio?.computeDuration()).toBeGreaterThan(0.9);
  });

  it("stops the remux when the user cancels during it: the job ends as cancelled, not as a kept transport stream", async () => {
    const names = ["hls-multi/seg007.ts", "hls-multi/seg008.ts", "hls-multi/seg009.ts"];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const name = String(url).split("example.com/").at(-1)!;
      return new Response(name.endsWith(".m3u8")
        ? ["#EXTM3U", "#EXT-X-TARGETDURATION:2", ...names.flatMap(segment => ["#EXTINF:1.0,", segment]), "#EXT-X-ENDLIST", ""].join("\n")
        : fixture(name) as BodyInit);
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const sink = new CapturingSink();
    const remuxing: (number | null)[] = [];
    const run = runHlsJob(plan, hlsDescriptor(), { signal: controller.signal, sink, onProgress: progress => {
      if (progress.stage.kind !== "remuxing") return;
      remuxing.push(progress.stage.fraction);
      if (remuxing.length === 2) controller.abort(new DOMException("user-cancelled", "AbortError"));
    } });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(remuxing.length).toBe(2);
    expect(sink.filename).toBe("");
  });

  // Damage that is no encryption: a player plays through it, and the save does too.
  describe("a stream with damaged packets", () => {
    const packetOf = (bytes: Uint8Array, wanted: number, from: number): number => {
      for (let index = from; index * 188 < bytes.length; index++) {
        if ((((bytes[index * 188 + 1]! & 31) << 8) | bytes[index * 188 + 2]!) === wanted) return index;
      }
      throw new Error("no such packet");
    };
    const playable = async (sink: CapturingSink): Promise<void> => {
      expect(sink.filename).toBe("clip.mp4");
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
      expect((await input.getPrimaryVideoTrack())?.codec).toBe("avc");
      expect((await input.getPrimaryAudioTrack())?.codec).toBe("aac");
      expect(await input.computeDuration()).toBeGreaterThan(0.8);
    };

    it("saves a stream with a packet the sender marked as damaged in transit", async () => {
      const marked = timedId3.slice();
      const at = packetOf(marked, 0x100, 40) * 188;
      marked[at + 1] = marked[at + 1]! | 0x80;
      await playable(await save(marked));
    });

    it("saves a stream whose program map arrives once with a wrong checksum", async () => {
      const flipped = timedId3.slice();
      const at = packetOf(flipped, 0x1000, 0) * 188;
      // The last byte of the table's checksum: the table itself is as it was sent.
      const last = at + 5 + 3 + (((flipped[at + 6]! & 15) << 8) | flipped[at + 7]!) - 1;
      flipped[last] = flipped[last]! ^ 1;
      await playable(await save(flipped));
    });

    it("saves a stream whose last packet was cut short", async () => {
      await playable(await save(timedId3.slice(0, -100)));
    });

    it("leaves a cut packet out of a middle segment, so the segments after it stay in step", async () => {
      const names = ["hls-multi/seg007.ts", "hls-multi/seg008.ts", "hls-multi/seg009.ts"];
      const whole = names.map(name => fixture(name));
      const cut = [whole[0]!, whole[1]!.slice(0, -50), whole[2]!];
      globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        const name = String(url).split("example.com/").at(-1)!;
        return new Response(name.endsWith(".m3u8")
          ? ["#EXTM3U", "#EXT-X-TARGETDURATION:2", ...names.flatMap(segment => ["#EXTINF:1.0,", segment]), "#EXT-X-ENDLIST", ""].join("\n")
          : cut[names.indexOf(name)]! as BodyInit);
      }) as unknown as typeof fetch;
      const sink = new CapturingSink();
      await runHlsJob(plan, hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });
      expect(sink.filename).toBe("clip.mp4");
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
      // All three parts are in the file: the third was not thrown out of step by the cut in the second.
      expect(await input.computeDuration()).toBeGreaterThan(2.8);
    });
  });

  // Clips joined in on the server (ads before or inside the video): each starts its clock again.
  describe("a stream whose clock starts again at a joint", () => {
    const part = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, "../../../e2e/media-fixtures", name)));
    const serve = (names: readonly string[]) => {
      const lines = names.flatMap((name, index) => [...(index > 0 && name === names[0] ? ["#EXT-X-DISCONTINUITY"] : []), "#EXTINF:1.0,", name]);
      const requested: string[] = [];
      globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
        const name = String(url).split("example.com/").at(-1)!;
        requested.push(name);
        return new Response(name.endsWith(".m3u8") ? ["#EXTM3U", "#EXT-X-TARGETDURATION:2", ...lines, "#EXT-X-ENDLIST", ""].join("\n") : part(name) as BodyInit);
      }) as unknown as typeof fetch;
      return requested;
    };
    const joinedBytes = (names: readonly string[]) => {
      const parts = names.map(part);
      const out = new Uint8Array(parts.reduce((sum, bytes) => sum + bytes.length, 0));
      let at = 0;
      for (const bytes of parts) { out.set(bytes, at); at += bytes.length; }
      return out;
    };
    const clip = ["hls-multi/seg007.ts", "hls-multi/seg008.ts", "hls-multi/seg009.ts"];

    it.each([
      // The MP4 muxer stops on these: before, the save failed with "Try again" and failed the same way on every retry.
      ["a three-second clip, then the same clock again", [...clip, ...clip]],
      // The MP4 muxer leaves the second clip out of these without a word: before, half the video was reported as saved.
      ["two one-part clips with one clock", ["hls/seg000.ts", "hls/seg000.ts"]],
      ["a later part followed by an earlier one", ["hls-multi/seg009.ts", "hls-multi/seg007.ts"]],
    ])("keeps every packet in order as a transport stream: %s", async (_name, names) => {
      const requested = serve(names);
      const sink = new CapturingSink();
      const stages: string[] = [];
      const result = await runHlsJob(plan, hlsDescriptor(), { onProgress: progress => { stages.push(progress.stage.kind); }, signal: new AbortController().signal, sink });
      expect(requested).toEqual(["master.m3u8", ...names]);
      expect(result.filename).toBe("clip.ts");
      expect(sink.filename).toBe("clip.ts");
      expect(sink.bytes()).toEqual(joinedBytes(names));
      expect(sink.aborted).toBe(false);
      // Known from the packets themselves, before any remux is tried.
      expect(stages).not.toContain("remuxing");
    });

    it("still writes an MP4 with all of the video when the clock runs on across the parts", async () => {
      serve(clip);
      const sink = new CapturingSink();
      await runHlsJob(plan, hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });
      expect(sink.filename).toBe("clip.mp4");
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(sink.bytes()) });
      expect(await input.computeDuration()).toBeGreaterThan(2.9);
    });
  });
});
