// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PackedAudioFrames, id3TagLength, packedAudioHead } from "../../../src/engine/packed-audio";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(process.cwd(), "tests/e2e/media-fixtures/hls-packed-audio", name)));
const SEGMENTS = ["a007.aac", "a008.aac", "a009.aac"].map(fixture);
const WHOLE = fixture("reference-audio.aac");

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** One ADTS frame of `payload` bytes after its seven header bytes. */
function adtsFrame(payload: number): Uint8Array {
  const length = 7 + payload;
  const frame = new Uint8Array(length).fill(0x11);
  frame.set([0xff, 0xf1, 0x50, 0x40 | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc]);
  return frame;
}

/** An ID3v2.4 tag with a body of `body` bytes, and a footer when asked. */
function tag(body: number, footer = false): Uint8Array {
  const bytes = new Uint8Array(10 + body + (footer ? 10 : 0));
  bytes.set([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0, (body >> 21) & 0x7f, (body >> 14) & 0x7f, (body >> 7) & 0x7f, body & 0x7f]);
  return bytes;
}

describe("id3TagLength", () => {
  it("is the header, the body and the footer of the tag", () => {
    expect(id3TagLength(tag(63))).toBe(73);
    expect(id3TagLength(tag(300))).toBe(310);
    expect(id3TagLength(tag(20, true))).toBe(40);
  });

  it("is 0 where no tag starts", () => {
    expect(id3TagLength(adtsFrame(20))).toBe(0);
    expect(id3TagLength(new Uint8Array([0x49, 0x44, 0x33]))).toBe(0);
    expect(id3TagLength(join(adtsFrame(20), tag(5)), 27)).toBe(15);
    // A size byte with its top bit set is no ID3 size.
    expect(id3TagLength(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x80, 1]))).toBe(0);
  });
});

describe("packedAudioHead", () => {
  it("reads the frames and the time the first tag states from a real packed audio segment", () => {
    // The fixture's video starts at 1.4 s on the transport stream's clock, and so does its audio.
    expect(packedAudioHead(SEGMENTS[0]!)).toEqual({ frames: "adts", startSeconds: 1.4 });
    expect(packedAudioHead(SEGMENTS[1]!)?.startSeconds).toBeCloseTo(1.4 + 44 * 1024 / 44100, 4);
  });

  it("reads all 33 bits of the time", () => {
    const head = SEGMENTS[0]!.slice(0, 200);
    const time = head.indexOf(0, 20) + 1;
    head.set([0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff], time);
    expect(packedAudioHead(head)?.startSeconds).toBe((2 ** 33 - 1) / 90000);
  });

  it("knows bare frames without a tag, and states no time for them", () => {
    expect(packedAudioHead(WHOLE)).toEqual({ frames: "adts", startSeconds: null });
    expect(packedAudioHead(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]))).toEqual({ frames: "mpeg", startSeconds: null });
  });

  it("is null for bytes that are no bare audio frames", () => {
    expect(packedAudioHead(new TextEncoder().encode("<!doctype html><html></html>"))).toBeNull();
    expect(packedAudioHead(join(tag(20), new TextEncoder().encode("not audio at all")))).toBeNull();
    expect(packedAudioHead(new Uint8Array(0))).toBeNull();
  });
});

describe("PackedAudioFrames", () => {
  it("gives the frames of every segment without its tag: together they are the whole audio", () => {
    const frames = new PackedAudioFrames("adts");
    const out = SEGMENTS.map(segment => frames.push(segment));
    expect(out.every(part => part !== null)).toBe(true);
    expect(Buffer.from(join(...(out as Uint8Array[]))).equals(Buffer.from(WHOLE))).toBe(true);
    // The tags are what was left out.
    expect(out.map((part, index) => SEGMENTS[index]!.length - part!.length)).toEqual([73, 73, 73]);
  });

  it("leaves out a tag between two frames", () => {
    const frames = new PackedAudioFrames("adts");
    const [a, b] = [adtsFrame(30), adtsFrame(41)];
    expect(frames.push(join(tag(12), a, tag(40, true), b))).toEqual(join(a, b));
  });

  it("completes a frame or a tag that a segment cuts off with the next segment", () => {
    const stream = join(tag(12), adtsFrame(30), adtsFrame(41), tag(9), adtsFrame(25));
    for (let cut = 1; cut < stream.length; cut++) {
      const frames = new PackedAudioFrames("adts");
      const first = frames.push(stream.subarray(0, cut));
      const second = frames.push(stream.subarray(cut));
      expect(first && second && join(first, second), `cut at ${cut}`).toEqual(join(adtsFrame(30), adtsFrame(41), adtsFrame(25)));
    }
  });

  it("answers null for a segment with bytes that are neither a tag nor a frame", () => {
    expect(new PackedAudioFrames("adts").push(join(tag(12), adtsFrame(30), new TextEncoder().encode("<html>an error page</html>")))).toBeNull();
    expect(new PackedAudioFrames("adts").push(join(adtsFrame(30), new Uint8Array(40)))).toBeNull();
  });

  it("takes only the opening tags off MP3 segments, whose reader finds each frame itself", () => {
    const frames = new PackedAudioFrames("mpeg");
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);
    expect(frames.push(join(tag(12), tag(3), mp3))).toEqual(mp3);
    expect(frames.push(mp3)).toEqual(mp3);
  });
});
