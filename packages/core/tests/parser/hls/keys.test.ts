import { describe, expect, it } from "vitest";
import {
  AES_128_KEY_BYTES,
  isClearAes128,
  isDecryptableLength,
  parseHlsKeyDeclarations,
  planHlsKeys,
  segmentIv,
} from "../../../src/parser/hls/keys";

const base = "https://x.test/media.m3u8";

const playlist = (keyTag: string) => `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
${keyTag}
#EXTINF:2.000000,
seg000.ts
#EXT-X-ENDLIST
`;

describe("EXT-X-KEY declarations", () => {
  it("reads METHOD, absolute URI, KEYFORMAT and IV", () => {
    const [key] = parseHlsKeyDeclarations(
      playlist('#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f'),
      base,
    );
    expect(key).toBeDefined();
    expect(key!.method).toBe("AES-128");
    expect(key!.keyUri).toBe("https://x.test/key.bin");
    expect(key!.keyFormat).toBe("identity");
    expect(key!.iv).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
  });

  it("defaults a missing KEYFORMAT to identity and lowercases a given one", () => {
    const [identity] = parseHlsKeyDeclarations(playlist('#EXT-X-KEY:METHOD=AES-128,URI="k"'), base);
    const [fairplay] = parseHlsKeyDeclarations(
      playlist('#EXT-X-KEY:METHOD=AES-128,URI="skd://k",KEYFORMAT="com.apple.streamingKeyDelivery"'),
      base,
    );
    expect(identity!.keyFormat).toBe("identity");
    expect(fairplay!.keyFormat).toBe("com.apple.streamingkeydelivery");
  });

  it("ignores a malformed IV instead of decrypting with a half one", () => {
    const [short] = parseHlsKeyDeclarations(playlist('#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x00ff'), base);
    const [notHex] = parseHlsKeyDeclarations(
      playlist('#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'),
      base,
    );
    expect(short!.iv).toBeNull();
    expect(notHex!.iv).toBeNull();
  });

  it("collects every key tag, so rotation is visible", () => {
    const rotating = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k1"
#EXTINF:2,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="k2"
#EXTINF:2,
b.ts
#EXT-X-ENDLIST
`;
    expect(parseHlsKeyDeclarations(rotating, base).map(d => d.keyUri)).toEqual([
      "https://x.test/k1",
      "https://x.test/k2",
    ]);
  });
});

describe("key plan", () => {
  const decl = (over: Partial<{ method: string; keyUri: string | null; keyFormat: string }> = {}) => ({
    method: "AES-128",
    keyUri: "https://x.test/key.bin",
    keyFormat: "identity",
    iv: null,
    ...over,
  });

  it("no keys, or only METHOD=NONE, is clear", () => {
    expect(planHlsKeys([])).toEqual({ kind: "clear" });
    expect(planHlsKeys([decl({ method: "NONE", keyUri: null })])).toEqual({ kind: "clear" });
  });

  it("AES-128 with an identity key is decryptable here", () => {
    expect(planHlsKeys([decl()])).toEqual({ kind: "aes-128" });
    expect(planHlsKeys([decl({ keyFormat: "" })])).toEqual({ kind: "aes-128" });
    expect(isClearAes128(decl())).toBe(true);
  });

  it("AES-128 behind a key system is DRM, not a key we may fetch", () => {
    const plan = planHlsKeys([decl({ keyFormat: "com.apple.streamingkeydelivery" })]);
    expect(plan).toEqual({ kind: "drm", keySystem: "com.apple.streamingkeydelivery" });
    expect(isClearAes128(decl({ keyFormat: "com.apple.streamingkeydelivery" }))).toBe(false);
  });

  it("SAMPLE-AES and SAMPLE-AES-CTR stay DRM", () => {
    expect(planHlsKeys([decl({ method: "SAMPLE-AES" })])).toEqual({ kind: "drm", keySystem: "SAMPLE-AES" });
    expect(planHlsKeys([decl({ method: "SAMPLE-AES-CTR" })])).toEqual({ kind: "drm", keySystem: "SAMPLE-AES-CTR" });
  });

  it("one unsupported tag poisons a playlist that is otherwise AES-128", () => {
    expect(planHlsKeys([decl(), decl({ method: "SAMPLE-AES" })])).toEqual({
      kind: "drm",
      keySystem: "SAMPLE-AES",
    });
  });

  it("a key tag without URI cannot be fetched, so it is not decryptable", () => {
    expect(planHlsKeys([decl({ keyUri: null })])).toEqual({ kind: "drm", keySystem: "identity" });
  });
});

describe("segment IV and block length", () => {
  it("uses the declared IV when it is 16 bytes", () => {
    const declared = new Uint8Array(AES_128_KEY_BYTES).fill(7);
    expect(segmentIv(declared, 42)).toBe(declared);
  });

  it("derives the IV from the media sequence, big endian (RFC 8216 section 5.2)", () => {
    expect(segmentIv(null, 0)).toEqual(new Uint8Array(16));
    expect(segmentIv(null, 1)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]));
    expect(segmentIv(null, 258)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]));
    expect(segmentIv(null, null)).toEqual(new Uint8Array(16));
  });

  it("falls back to the sequence when the declared IV is the wrong size", () => {
    expect(segmentIv(new Uint8Array([1, 2, 3]), 1)).toEqual(
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    );
  });

  it("only whole AES blocks are decryptable", () => {
    expect(isDecryptableLength(0)).toBe(false);
    expect(isDecryptableLength(15)).toBe(false);
    expect(isDecryptableLength(16)).toBe(true);
    expect(isDecryptableLength(128416)).toBe(true);
  });
});
