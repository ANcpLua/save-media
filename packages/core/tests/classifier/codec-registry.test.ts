import { describe, expect, it } from "vitest";
import { parseVideoCodec, parseAudioCodec, friendlyVideoCodec, friendlyAudioCodec } from "../../src/classifier/codec-registry";

describe("codec-registry video", () => {
  it("parses avc1.640028 → H.264 High @ 4.0", () => {
    const codec = parseVideoCodec("avc1.640028");
    expect(codec).not.toBeNull();
    expect(codec?.family).toBe("h264");
    expect(codec?.profile).toBe("High");
    expect(codec?.level).toBe("4.0");
    expect(friendlyVideoCodec(codec!)).toBe("H.264 High @ 4.0");
  });

  it("parses hvc1.1.6.L150.B0 → H.265 Main @ 5.0", () => {
    const codec = parseVideoCodec("hvc1.1.6.L150.B0");
    expect(codec?.family).toBe("h265");
    expect(friendlyVideoCodec(codec!)).toBe("H.265 Main @ 5.0");
  });

  it("parses vp09.00.50.08 → VP9", () => {
    const codec = parseVideoCodec("vp09.00.50.08");
    expect(codec?.family).toBe("vp9");
  });

  it("parses av01.0.05M.08 → AV1", () => {
    const codec = parseVideoCodec("av01.0.05M.08");
    expect(codec?.family).toBe("av1");
  });

  it("returns null for unknown codec strings", () => {
    expect(parseVideoCodec("nope.123")).toBeNull();
  });
});

describe("codec-registry audio", () => {
  it("parses mp4a.40.2 → AAC-LC", () => {
    const codec = parseAudioCodec("mp4a.40.2");
    expect(codec?.family).toBe("aac");
    expect(friendlyAudioCodec(codec!)).toBe("AAC-LC");
  });

  it("parses opus → Opus", () => {
    const codec = parseAudioCodec("opus");
    expect(codec?.family).toBe("opus");
    expect(friendlyAudioCodec(codec!)).toBe("Opus");
  });

  it("parses ac-3 and ec-3", () => {
    expect(parseAudioCodec("ac-3")?.family).toBe("ac3");
    expect(parseAudioCodec("ec-3")?.family).toBe("eac3");
  });
});
