import { describe, expect, it } from "vitest";
import { coveredFileEnd, coveredFileWithGaps } from "../../src/parser/byte-ranges";

describe("coveredFileEnd", () => {
  it("gives the end of ranges that cover a file from its first byte without a gap", () => {
    expect(coveredFileEnd([{ offset: 0, length: 800 }, { offset: 800, length: 200 }, { offset: 1000, length: 24 }])).toBe(1024);
    expect(coveredFileEnd([{ offset: 0, length: 5 }])).toBe(5);
  });

  it.each([
    ["a gap", [{ offset: 0, length: 800 }, { offset: 900, length: 100 }]],
    ["an overlap", [{ offset: 0, length: 800 }, { offset: 700, length: 300 }]],
    ["a start after the first byte", [{ offset: 10, length: 790 }, { offset: 800, length: 200 }]],
    ["ranges out of order", [{ offset: 800, length: 200 }, { offset: 0, length: 800 }]],
    ["a part without a range", [{ offset: 0, length: 800 }, undefined]],
    ["an empty range", [{ offset: 0, length: 800 }, { offset: 800, length: 0 }]],
    ["no ranges at all", []],
  ])("gives null for %s", (_name, ranges) => {
    expect(coveredFileEnd(ranges)).toBeNull();
  });
});

describe("coveredFileWithGaps", () => {
  it("gives the end of ranges that move forward from the first byte, and the stretches between them", () => {
    // A header, an index the playlist does not name, then the parts.
    expect(coveredFileWithGaps([{ offset: 0, length: 870 }, { offset: 938, length: 99313 }, { offset: 100251, length: 10 }]))
      .toEqual({ end: 100261, gaps: [{ offset: 870, length: 68 }] });
    expect(coveredFileWithGaps([{ offset: 0, length: 800 }, { offset: 800, length: 200 }])).toEqual({ end: 1000, gaps: [] });
    expect(coveredFileWithGaps([{ offset: 0, length: 8 }, { offset: 10, length: 2 }, { offset: 20, length: 4 }]))
      .toEqual({ end: 24, gaps: [{ offset: 8, length: 2 }, { offset: 12, length: 8 }] });
  });

  it.each([
    ["an overlap", [{ offset: 0, length: 800 }, { offset: 700, length: 300 }]],
    ["a start after the first byte", [{ offset: 10, length: 790 }, { offset: 800, length: 200 }]],
    ["ranges out of order", [{ offset: 0, length: 100 }, { offset: 800, length: 200 }, { offset: 100, length: 700 }]],
    ["a part without a range", [{ offset: 0, length: 800 }, undefined]],
    ["an empty range", [{ offset: 0, length: 800 }, { offset: 900, length: 0 }]],
    ["no ranges at all", []],
  ])("gives null for %s", (_name, ranges) => {
    expect(coveredFileWithGaps(ranges)).toBeNull();
  });
});
