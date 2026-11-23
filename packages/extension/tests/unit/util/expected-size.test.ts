import { describe, expect, it } from "vitest";
import { declaredTotalBytes, expectedSize, sizeText } from "../../../src/util/expected-size";
import { dashDescriptor, directDescriptor, hlsDescriptor } from "../popup/helpers/descriptors";

describe("expected download size", () => {
  it("reports a direct file's declared length exactly", () => {
    const file = directDescriptor({ source: { kind: "direct-url", url: "https://cdn.example/clip.mp4",
      headers: { "content-range": "bytes 0-1023/257425408", "content-length": "1024" } } });
    expect(expectedSize(file, file.variants[0])).toEqual({ bytes: 257_425_408, exact: true });
    expect(sizeText({ bytes: 257_425_408, exact: true })).toBe("245.5 MB");
  });

  it("estimates a stream from its bit rate over the playing video's duration", () => {
    const stream = hlsDescriptor();
    const variant = { ...stream.variants[0]!, estimatedSize: null, bitrate: 2_000_000 };
    expect(expectedSize(stream, variant, 2869)).toEqual({ bytes: 717_250_000, exact: false });
    expect(sizeText(expectedSize(stream, variant, 2869)!)).toBe("~684.0 MB");
    // A live stream or an unknown duration has no size.
    expect(expectedSize(stream, variant, Infinity)).toBeNull();
    expect(expectedSize(stream, variant, null)).toBeNull();
  });

  it("adds a separate audio track to a manifest estimate", () => {
    const stream = dashDescriptor();
    const variant = stream.variants[0]!;
    const audio = stream.audioRenditions?.find(item => item.audioRenditionId === variant.audioRenditionId);
    expect(expectedSize(stream, variant)).toEqual({
      bytes: (variant.estimatedSize ?? 0) + (audio?.estimatedSize ?? 0), exact: false,
    });
  });

  it("formats kilobytes, megabytes and gigabytes", () => {
    expect(sizeText({ bytes: 900, exact: true })).toBe("900 B");
    expect(sizeText({ bytes: 48_000, exact: true })).toBe("46.9 KB");
    expect(sizeText({ bytes: 3_400_000_000, exact: false })).toBe("~3.17 GB");
  });

  it("keeps an unknown or unparsable total unknown", () => {
    expect(declaredTotalBytes({ "content-range": "bytes 0-1023/*" })).toBeNull();
    expect(declaredTotalBytes({})).toBeNull();
  });
});
