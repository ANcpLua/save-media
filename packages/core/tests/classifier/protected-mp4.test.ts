import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findMp4Protection } from "../../src/classifier/protected-mp4";

const here = dirname(fileURLToPath(import.meta.url));
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));

function box(type: string, ...children: (Uint8Array | number[])[]): Uint8Array {
  const payload = children.map(child => Uint8Array.from(child));
  const size = 8 + payload.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(ascii(type), 4);
  let offset = 8;
  for (const part of payload) { out.set(part, offset); offset += part.length; }
  return out;
}

const fullBox = (type: string, ...children: (Uint8Array | number[])[]) => box(type, [0, 0, 0, 0], ...children);
const WIDEVINE = [0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed];

// A VisualSampleEntry: 8 SampleEntry bytes and 70 visual fields precede its child boxes.
const visualEntry = (type: string, ...children: Uint8Array[]) => box(type, new Array(78).fill(0), ...children);
// An AudioSampleEntry (version 0): 8 SampleEntry bytes and 20 audio fields.
const audioEntry = (type: string, ...children: Uint8Array[]) => box(type, new Array(28).fill(0), ...children);
const sinf = (scheme: string, original: string) => box("sinf",
  box("frma", ascii(original)),
  fullBox("schm", ascii(scheme), [0, 1, 0, 0]),
  box("schi", fullBox("tenc", [0, 0, 1, 8], new Array(16).fill(7))));

function initSegment(entry: Uint8Array, ...moovExtras: Uint8Array[]): Uint8Array {
  const stsd = fullBox("stsd", [0, 0, 0, 1], entry);
  const trak = box("trak", box("tkhd", new Array(84).fill(0)),
    box("mdia", box("mdhd", new Array(24).fill(0)), box("minf", box("stbl", stsd, fullBox("stts", [0, 0, 0, 0])))));
  const ftyp = box("ftyp", ascii("iso6"), [0, 0, 0, 0], ascii("iso6dash"));
  const moov = box("moov", box("mvhd", new Array(100).fill(0)), ...moovExtras, trak);
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp);
  out.set(moov, ftyp.length);
  return out;
}

describe("findMp4Protection", () => {
  it("finds nothing in clear init segments and files", () => {
    expect(findMp4Protection(initSegment(visualEntry("avc1", box("avcC", [1, 66, 0, 30]))))).toBeNull();
    expect(findMp4Protection(initSegment(audioEntry("mp4a", fullBox("esds", [3, 0]))))).toBeNull();
    for (const path of ["fixtures/init-segments/h264-baseline.mp4", "../../extension/tests/e2e/media-fixtures/direct/clip.mp4"]) {
      expect(findMp4Protection(new Uint8Array(readFileSync(resolve(here, "..", path))))).toBeNull();
    }
  });

  it("refuses a CENC video init segment by its protected sample entry and scheme", () => {
    const protectedInit = initSegment(visualEntry("encv", box("avcC", [1, 66, 0, 30]), sinf("cenc", "avc1")));
    expect(findMp4Protection(protectedInit)).toEqual({ scheme: "cenc", keySystem: null });
  });

  it("refuses a cbcs audio init segment and names the key system from its pssh", () => {
    const pssh = box("pssh", [0, 0, 0, 0], WIDEVINE, [0, 0, 0, 0]);
    const protectedInit = initSegment(audioEntry("enca", fullBox("esds", [3, 0]), sinf("cbcs", "mp4a")), pssh);
    expect(findMp4Protection(protectedInit)).toEqual({ scheme: "cbcs", keySystem: "com.widevine.alpha" });
  });

  it("refuses a pssh alone, and an unknown system keeps its urn", () => {
    const pssh = box("pssh", [0, 0, 0, 0], new Array(16).fill(0xab), [0, 0, 0, 0]);
    expect(findMp4Protection(initSegment(visualEntry("avc1"), pssh)))
      .toEqual({ scheme: null, keySystem: "urn:uuid:abababab-abab-abab-abab-abababababab" });
  });

  it("refuses a media segment whose fragment carries sample encryption data", () => {
    const fragment = new Uint8Array([...box("moof", fullBox("mfhd", [0, 0, 0, 1]),
      box("traf", fullBox("tfhd", [0, 0, 0, 1]), fullBox("senc", [0, 0, 0, 0]))), ...box("mdat", [1, 2, 3])]);
    expect(findMp4Protection(fragment)).toEqual({ scheme: null, keySystem: null });
  });

  it("reads a probe prefix that cuts the movie box short", () => {
    const protectedInit = initSegment(visualEntry("encv", sinf("cbcs", "hvc1")));
    expect(findMp4Protection(protectedInit.subarray(0, protectedInit.length - 3))).toMatchObject({ scheme: "cbcs" });
  });
});
