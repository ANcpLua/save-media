import { describe, expect, it } from "vitest";
import { contentId } from "../../../src/util/content-id";
import { fromWire, toWire } from "../../../src/util/wire";
import { hlsDescriptor } from "../popup/helpers/descriptors";

describe("content ids", () => {
  it("gives the same parts the same id and different parts a different one", () => {
    const id = contentId([7, "direct-url:progressive::https://example.com/a.mp4"]);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(contentId([7, "direct-url:progressive::https://example.com/a.mp4"])).toBe(id);
    expect(contentId([8, "direct-url:progressive::https://example.com/a.mp4"])).not.toBe(id);
    expect(contentId([7, "direct-url:progressive::https://example.com/b.mp4"])).not.toBe(id);
    // The parts are told apart, not joined.
    expect(contentId(["ab", "c"])).not.toBe(contentId(["a", "bc"]));
    expect(contentId([1, "2"])).not.toBe(contentId(["1", 2]));
  });

  it("spreads many addresses without a clash", () => {
    const ids = new Set(Array.from({ length: 20_000 }, (_, n) => contentId([1, `https://cdn.example/feed/${n}.mp4`])));
    expect(ids.size).toBe(20_000);
  });
});

describe("wire form", () => {
  it("carries a descriptor with a key's IV through JSON and back", () => {
    const iv = new Uint8Array([0, 1, 2, 253, 254, 255, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    const base = hlsDescriptor();
    const descriptor = { ...base, variants: base.variants.map(variant => ({ ...variant,
      segmentRef: { ...variant.segmentRef, encryption: { method: "AES-128", keyUri: "https://keys.example/k", iv } } })) };
    const stored = JSON.parse(JSON.stringify(toWire(descriptor))) as unknown;
    const back = fromWire<typeof descriptor>(stored);
    expect(back).toEqual(descriptor);
    expect(back.variants[0]!.segmentRef.encryption.iv).toBeInstanceOf(Uint8Array);
  });

  it("leaves plain values alone and never mistakes page data for bytes", () => {
    const value = { a: [1, "two", null, true], b: { $bytes: "not hex" }, c: { $bytes: "00", other: 1 } };
    expect(fromWire(JSON.parse(JSON.stringify(toWire(value))))).toEqual(value);
  });
});
