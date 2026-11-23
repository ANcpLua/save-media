// @vitest-environment node
//
// mediabunny's mux is environment-agnostic (it copies encoded
// packets, no WebCodecs decode), so this runs in a plain node environment to
// exercise the REAL muxer against real ffmpeg-generated fixtures — not a mock.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { mergeAvToMp4 } from "../../../src/engine/remux/merge-av";

const fixture = (name: string) =>
  new Blob([new Uint8Array(readFileSync(resolve(process.cwd(), "tests/unit/engine/fixtures", name)))]);
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

const videoOnly = fixture("video-only.mp4"); // H.264, no audio track
const audioOnly = fixture("audio-only.m4a"); // AAC, no video track

describe("mergeAvToMp4", () => {
  it("muxes a demuxed video + audio pair into one MP4 carrying both tracks", async () => {
    const merged = await bytesOf(await mergeAvToMp4(videoOnly, audioOnly));

    // ftyp box at bytes 4..8 → a real MP4, not concatenated garbage.
    expect(String.fromCharCode(merged[4]!, merged[5]!, merged[6]!, merged[7]!)).toBe("ftyp");

    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(merged) });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    expect(video).not.toBeNull();
    expect(audio).not.toBeNull();
    expect(video?.codec).toBe("avc");
    expect(audio?.codec).toBe("aac");
  });

  it("reports monotonic progress that ends at 1", async () => {
    const seen: number[] = [];
    await mergeAvToMp4(videoOnly, audioOnly, f => seen.push(f));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });

  it("rejects a pair with no usable video track", async () => {
    // Two audio-only inputs → the 'video' side has no video track.
    await expect(mergeAvToMp4(audioOnly, audioOnly)).rejects.toThrow(/no video track/);
  });

  it("rejects a pair with no usable audio track", async () => {
    await expect(mergeAvToMp4(videoOnly, videoOnly)).rejects.toThrow(/no audio track/);
  });

  it("puts a stream that has no audio into an MP4 with its picture alone", async () => {
    const saved = await bytesOf(await mergeAvToMp4(videoOnly, null));
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(saved) });
    expect((await input.getPrimaryVideoTrack())?.codec).toBe("avc");
    expect(await input.getPrimaryAudioTrack()).toBeNull();
  });

  // One DASH representation can hold video and audio together (codecs="avc1...,mp4a..."),
  // and then the manifest has no audio AdaptationSet: the sound is in the video stream.
  it("keeps the sound a video stream carries itself when no separate audio stream exists", async () => {
    const muxed = new Blob([new Uint8Array(readFileSync(resolve(process.cwd(), "tests/e2e/media-fixtures/direct/clip-dash-brand.mp4")))]);
    const packets = async (bytes: Uint8Array) => {
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
      const video = await input.getPrimaryVideoTrack();
      const audio = await input.getPrimaryAudioTrack();
      const sizes = async (track: typeof video | typeof audio) => {
        const out: number[] = [];
        if (track) for await (const packet of new EncodedPacketSink(track).packets()) out.push(packet.data.byteLength);
        return out;
      };
      return { video: video?.codec ?? null, audio: audio?.codec ?? null, videoPackets: await sizes(video), audioPackets: await sizes(audio) };
    };
    const source = await packets(await bytesOf(muxed));
    expect(source).toMatchObject({ video: "avc", audio: "aac" });
    expect(source.audioPackets.length).toBeGreaterThan(10);

    const saved = await packets(await bytesOf(await mergeAvToMp4(muxed, null)));
    expect(saved).toEqual(source);
  });

  it("copies every packet unchanged and in each track's own order", async () => {
    const merged = await bytesOf(await mergeAvToMp4(videoOnly, audioOnly));
    const sizes = async (bytes: Uint8Array, kind: "video" | "audio") => {
      const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
      const track = kind === "video" ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
      const out: number[] = [];
      for await (const packet of new EncodedPacketSink(track!).packets()) out.push(packet.data.byteLength);
      return out;
    };
    expect(await sizes(merged, "video")).toEqual(await sizes(await bytesOf(videoOnly), "video"));
    expect(await sizes(merged, "audio")).toEqual(await sizes(await bytesOf(audioOnly), "audio"));
  });

  // The fixtures come from scripts/generate-merge-codec-fixtures.mjs.
  it.each([
    ["fragmented MP4", "video-vp9.frag.mp4", "audio-opus.frag.mp4"],
    ["WebM", "video-vp9.webm", "audio-opus.webm"],
  ])("puts VP9 video and Opus audio that arrive as %s into one MP4 that reads back with both tracks", async (_name, videoName, audioName) => {
    const merged = await bytesOf(await mergeAvToMp4(fixture(videoName), fixture(audioName)));
    expect(String.fromCharCode(merged[4]!, merged[5]!, merged[6]!, merged[7]!)).toBe("ftyp");
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(merged) });
    expect(await input.getFormat()).toMatchObject({ name: "MP4" });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    expect(video?.codec).toBe("vp9");
    expect(audio?.codec).toBe("opus");
    let frames = 0;
    for await (const _packet of new EncodedPacketSink(video!).packets()) frames++;
    expect(frames).toBe(5);
    expect(await audio!.computeDuration()).toBeGreaterThan(0.9);
  });

  it("writes the media before the index, so the muxer never holds the file", async () => {
    const merged = await bytesOf(await mergeAvToMp4(videoOnly, audioOnly));
    const order: string[] = [];
    const view = new DataView(merged.buffer);
    for (let offset = 0; offset + 8 <= merged.length;) {
      let size = view.getUint32(offset);
      order.push(String.fromCharCode(...merged.subarray(offset + 4, offset + 8)));
      if (size === 1) size = Number(view.getBigUint64(offset + 8));
      if (size < 8) break;
      offset += size;
    }
    expect(order).toEqual(["ftyp", "mdat", "moov"]);
  });
});
