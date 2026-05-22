import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHlsMaster } from "../../../src/parser/hls/adapter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, `../../fixtures/hls/${name}`), "utf-8");
const expected = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, `../../fixtures/hls/${name}`), "utf-8")) as unknown;

describe("parseHlsMaster", () => {
  it("master-vod-h264-aac.m3u8 → 3 variants", () => {
    const r = parseHlsMaster(fixture("master-vod-h264-aac.m3u8"), "https://x.test/master.m3u8");
    const exp = expected("master-vod-h264-aac.expected.json") as {
      variantCount: number;
      variants: Array<{
        height: number;
        videoCodecRfc6381: string;
        audioCodecRfc6381: string;
        bitrate: number;
      }>;
    };

    expect(r.variants).toHaveLength(exp.variantCount);
    expect(r.encryption).toBeNull();

    for (let i = 0; i < exp.variants.length; i++) {
      const e = exp.variants[i];
      const a = r.variants[i];
      if (!e || !a) continue;
      expect(a.height).toBe(e.height);
      expect(a.videoCodec?.rfc6381).toBe(e.videoCodecRfc6381);
      expect(a.audioCodec?.rfc6381).toBe(e.audioCodecRfc6381);
      expect(a.bitrate).toBe(e.bitrate);
    }
  });
});
