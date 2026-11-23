import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beginsWholeMediaFile } from "../../src/classifier/whole-file";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../extension/tests/e2e/media-fixtures");
const head = (name: string, length = 4096): { bytes: Uint8Array; total: number } => {
  const whole = readFileSync(join(fixtures, name));
  return { bytes: new Uint8Array(whole.subarray(0, length)), total: whole.length };
};

const text = (value: string): number[] => [...value].map(char => char.charCodeAt(0));
const u32 = (value: number): number[] => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
/** A box with the given children or filler bytes. `declared` overrides the size the header states. */
function box(type: string, body: readonly number[] | number = [], declared?: number): number[] {
  const content = typeof body === "number" ? new Array<number>(body).fill(0) : [...body];
  return [...u32(declared ?? 8 + content.length), ...text(type), ...content];
}
const bytes = (...parts: readonly number[][]): Uint8Array => new Uint8Array(parts.flat());
const ftyp = box("ftyp", [...text("isom"), 0, 0, 0, 0]);

describe("beginsWholeMediaFile: MP4 and QuickTime", () => {
  it("takes the files of the repository's own fixtures by their first bytes", () => {
    for (const [name, container] of [["direct/clip.mp4", "mp4"], ["direct/clip-dash-brand.mp4", "fmp4"], ["direct/test-pattern.mov", "mov"]] as const) {
      const { bytes: start, total } = head(name);
      expect(beginsWholeMediaFile(start, container, total), name).toBe(true);
    }
  });

  it("takes a file whose movie box comes first, last, or is longer than the bytes that were read", () => {
    const movie = box("moov", [...box("mvhd", 100), ...box("trak", 200)]);
    expect(beginsWholeMediaFile(bytes(ftyp, movie, box("mdat", 16)), "mp4", 400)).toBe(true);
    // Media data first: the movie box is at the end of the file, beyond what was read.
    expect(beginsWholeMediaFile(bytes(ftyp, box("free", 8), box("mdat", 64, 9_000_000)), "mp4", 9_100_000)).toBe(true);
    // A movie box that goes on past the bytes read and declares no fragments in what was read.
    expect(beginsWholeMediaFile(bytes(ftyp, box("moov", [...box("mvhd", 100), ...box("trak", 200)], 60_000)), "mp4", 5_000_000)).toBe(true);
    // An old QuickTime file without a file type box.
    expect(beginsWholeMediaFile(bytes(box("wide"), box("mdat", 64, 500_000)), "mov", 600_000)).toBe(true);
    // Its length is not needed where the bytes themselves show media data.
    expect(beginsWholeMediaFile(bytes(ftyp, movie, box("mdat", 16)), "mp4", null)).toBe(true);
  });

  it("takes a fragmented file fetched whole, and never the init section or a fragment of a stream", () => {
    const fragmented = box("moov", [...box("mvhd", 100), ...box("trak", 200), ...box("mvex", box("trex", 24))]);
    const init = bytes(ftyp, fragmented);
    // The init section of a stream: the movie box declares fragments, and nothing follows it.
    expect(beginsWholeMediaFile(init, "mp4", init.length)).toBe(false);
    // Whether anything follows is not known without the answer's length.
    expect(beginsWholeMediaFile(init, "mp4", null)).toBe(false);
    // The same boxes with fragments after them are a file.
    expect(beginsWholeMediaFile(init, "mp4", init.length + 80_000)).toBe(true);
    expect(beginsWholeMediaFile(bytes(ftyp, fragmented, box("moof", 40), box("mdat", 40)), "fmp4", null)).toBe(true);
    // Fragments of a stream.
    for (const first of ["styp", "moof", "sidx", "emsg", "prft"]) {
      const fragment = bytes(box(first, 24), box("moof", 40), box("mdat", 40));
      expect(beginsWholeMediaFile(fragment, "fmp4", fragment.length), first).toBe(false);
    }
  });

  it("takes nothing from bytes that hold no movie and no media data", () => {
    expect(beginsWholeMediaFile(bytes(ftyp), "mp4", 1_000_000)).toBe(false);
    expect(beginsWholeMediaFile(bytes(ftyp, box("free", 32)), "mp4", 1_000_000)).toBe(false);
    expect(beginsWholeMediaFile(new Uint8Array(0), "mp4", 1_000_000)).toBe(false);
    expect(beginsWholeMediaFile(new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4]), "mp4", 8)).toBe(false);
  });
});

describe("beginsWholeMediaFile: WebM and Matroska", () => {
  const EBML = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01];
  const segment = (...children: number[][]): number[] => [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...children.flat()];
  const info = [0x15, 0x49, 0xa9, 0x66, 0x82, 0, 0];
  const tracks = [0x16, 0x54, 0xae, 0x6b, 0x83, 0, 0, 0];
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x84, 0, 0, 0, 0];

  it("takes the repository's own files, whose answers go on past the bytes read", () => {
    for (const [name, container] of [["direct/clip.webm", "webm"], ["direct/clip.mkv", "mkv"], ["mse/clip.webm", "webm"]] as const) {
      const { bytes: start, total } = head(name);
      expect(beginsWholeMediaFile(start, container, total), name).toBe(true);
    }
  });

  it("tells an init section from a short whole file by the Cluster", () => {
    const init = bytes(EBML, segment(info, tracks));
    expect(beginsWholeMediaFile(init, "webm", init.length)).toBe(false);
    expect(beginsWholeMediaFile(init, "webm", null)).toBe(false);
    const short = bytes(EBML, segment(info, tracks, cluster));
    expect(beginsWholeMediaFile(short, "webm", short.length)).toBe(true);
    expect(beginsWholeMediaFile(short, "mkv", null)).toBe(true);
    // The same header of an answer that goes on is a file.
    expect(beginsWholeMediaFile(init, "webm", 80_000)).toBe(true);
    // A Cluster on its own is a part of a stream, and bytes that end inside an element decide nothing.
    expect(beginsWholeMediaFile(bytes(cluster), "webm", cluster.length)).toBe(false);
    expect(beginsWholeMediaFile(bytes(EBML, [0x18, 0x53]), "webm", null)).toBe(false);
  });
});

describe("beginsWholeMediaFile: other containers", () => {
  it("never takes a transport stream or bytes of no known kind", () => {
    const { bytes: start, total } = head("hls/seg000.ts");
    expect(beginsWholeMediaFile(start, "mpegts", total)).toBe(false);
    expect(beginsWholeMediaFile(new Uint8Array(64), "unknown", 64)).toBe(false);
  });
});
