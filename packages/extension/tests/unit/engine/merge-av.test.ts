// @vitest-environment node
//
// mediabunny's in-memory mux is environment-agnostic (it copies encoded
// packets, no WebCodecs decode), so this runs in a plain node environment to
// exercise the REAL muxer against real ffmpeg-generated fixtures — not a mock.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { mergeAvToMp4 } from "../../../src/engine/remux/merge-av";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(process.cwd(), "tests/unit/engine/fixtures", name)));

const videoOnly = fixture("video-only.mp4"); // H.264, no audio track
const audioOnly = fixture("audio-only.m4a"); // AAC, no video track

describe("mergeAvToMp4", () => {
  it("muxes a demuxed video + audio pair into one MP4 carrying both tracks", async () => {
    const merged = await mergeAvToMp4(videoOnly, audioOnly);

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
});
