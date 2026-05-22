import { describe, expect, it } from "vitest";
import type { VideoCodec, AudioCodec, CodecSet, Variant, VideoCodecFamily } from "../../src/types/codec";

describe("codec types", () => {
  it("VideoCodec constructs with RFC 6381 string", () => {
    const codec: VideoCodec = {
      rfc6381: "avc1.640028",
      family: "h264",
      profile: "High",
      level: "4.0",
    };
    expect(codec.family).toBe<VideoCodecFamily>("h264");
  });

  it("AudioCodec allows null rfc6381 for legacy formats", () => {
    const codec: AudioCodec = {
      rfc6381: null,
      family: "mp3",
      channels: 2,
      sampleRate: 44100,
    };
    expect(codec.rfc6381).toBeNull();
  });

  it("CodecSet defaults to empty subtitles array", () => {
    const set: CodecSet = { video: null, audio: null, subtitles: [] };
    expect(set.subtitles).toHaveLength(0);
  });

  it("Variant carries per-variant codecs distinct from the StreamDescriptor's union", () => {
    const variant: Variant = {
      id: "var-1" as Variant["id"],
      width: 1920,
      height: 1080,
      frameRate: 30,
      bitrate: 5_200_000,
      estimatedSize: 84_300_000,
      videoCodec: { rfc6381: "avc1.640028", family: "h264", profile: "High", level: "4.0" },
      audioCodec: { rfc6381: "mp4a.40.2", family: "aac", channels: 2, sampleRate: 48000 },
      audioRenditionId: null,
      segmentRef: { kind: "direct", url: "https://example.com/v.mp4" },
    };
    expect(variant.width).toBe(1920);
  });
});
