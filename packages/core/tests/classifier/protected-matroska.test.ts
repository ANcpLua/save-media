import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasMatroskaEncryption, MATROSKA_SEGMENT, readEbmlHeader } from "../../src/classifier/protected-matroska";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(here, "../../../extension/tests/e2e/media-fixtures/direct", name)));

/** One EBML element: its ID bytes, a 4-byte size (or unknown), then the children. */
function element(id: number[], ...children: (Uint8Array | number[])[]): Uint8Array {
  const payload = children.map(child => Uint8Array.from(child));
  const size = payload.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(id.length + 4 + size);
  out.set(id);
  out.set([0x10 | (size >>> 24), (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff], id.length);
  let offset = id.length + 4;
  for (const part of payload) { out.set(part, offset); offset += part.length; }
  return out;
}

/** An element of unknown size (0xFF), as live and streamed files write their Segment. */
function unknownSize(id: number[], ...children: Uint8Array[]): Uint8Array {
  return Uint8Array.from([...id, 0xff, ...children.flatMap(child => [...child])]);
}

const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT = [0x18, 0x53, 0x80, 0x67];
const INFO = [0x15, 0x49, 0xa9, 0x66];
const TRACKS = [0x16, 0x54, 0xae, 0x6b];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const TRACK_ENTRY = [0xae];
const CODEC_ID = [0x86];
const CONTENT_ENCODINGS = [0x6d, 0x80];
const CONTENT_ENCODING = [0x62, 0x40];
const CONTENT_ENCODING_TYPE = [0x50, 0x33];
const CONTENT_ENCRYPTION = [0x50, 0x35];
const CONTENT_COMPRESSION = [0x50, 0x34];
const CONTENT_ENC_ALGO = [0x47, 0xe1];
const CONTENT_ENC_KEY_ID = [0x47, 0xe2];

const header = element(EBML, element([0x42, 0x82], ascii("webm")));
const track = (...encodings: Uint8Array[]) => element(TRACK_ENTRY, element([0xd7], [1]), element(CODEC_ID, ascii("V_VP9")), ...encodings);
const encrypted = element(CONTENT_ENCODINGS, element(CONTENT_ENCODING, element(CONTENT_ENCODING_TYPE, [1]),
  element(CONTENT_ENCRYPTION, element(CONTENT_ENC_ALGO, [5]), element(CONTENT_ENC_KEY_ID, new Array(16).fill(9)))));

function file(...tracks: Uint8Array[]): Uint8Array {
  const segment = unknownSize(SEGMENT, element(INFO, element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])), element(TRACKS, ...tracks),
    element(CLUSTER, element([0xe7], [0])));
  return Uint8Array.from([...header, ...segment]);
}

describe("hasMatroskaEncryption", () => {
  it("finds ContentEncryption in a track's content encodings", () => {
    expect(hasMatroskaEncryption(file(track(encrypted)))).toBe(true);
  });

  it("finds a ContentEncodingType of 1 even before its ContentEncryption element is read", () => {
    const cut = element(CONTENT_ENCODINGS, element(CONTENT_ENCODING, element(CONTENT_ENCODING_TYPE, [1])));
    expect(hasMatroskaEncryption(file(track(cut)))).toBe(true);
  });

  it("reads a Tracks element cut from a file", () => {
    expect(hasMatroskaEncryption(element(TRACKS, track(), track(encrypted)))).toBe(true);
  });

  it("is false for clear tracks, compressed tracks and the clear WebM and Matroska fixtures", () => {
    const compressed = element(CONTENT_ENCODINGS, element(CONTENT_ENCODING, element(CONTENT_ENCODING_TYPE, [0]),
      element(CONTENT_COMPRESSION, element([0x42, 0x54], [3]))));
    expect(hasMatroskaEncryption(file(track()))).toBe(false);
    expect(hasMatroskaEncryption(file(track(compressed)))).toBe(false);
    expect(hasMatroskaEncryption(fixture("clip.webm"))).toBe(false);
    expect(hasMatroskaEncryption(fixture("clip.mkv"))).toBe(false);
  });

  it("stops at the first cluster: frame data is never read as a declaration", () => {
    const afterCluster = Uint8Array.from([...header,
      ...unknownSize(SEGMENT, element(TRACKS, track()), element(CLUSTER, element([0xa3], [...CONTENT_ENCRYPTION, 0x80])), element(TRACKS, track(encrypted)))]);
    expect(hasMatroskaEncryption(afterCluster)).toBe(false);
  });

  it("reads element headers with unknown sizes", () => {
    expect(readEbmlHeader(Uint8Array.from([...SEGMENT, 0xff]), 0)).toEqual({ id: MATROSKA_SEGMENT, headerSize: 5, size: null });
    expect(readEbmlHeader(Uint8Array.from([...SEGMENT, 0x81]), 0)).toEqual({ id: MATROSKA_SEGMENT, headerSize: 5, size: 1 });
    expect(readEbmlHeader(Uint8Array.from([0x00, 0x81]), 0)).toBeNull();
  });
});
