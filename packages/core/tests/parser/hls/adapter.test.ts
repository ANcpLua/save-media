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

describe("parseHlsMaster — EXT-X-MEDIA audio groups", () => {
  it("master without EXT-X-MEDIA yields no renditions and null variant links", () => {
    const r = parseHlsMaster(fixture("master-vod-h264-aac.m3u8"), "https://x.test/master.m3u8");
    expect(r.audioRenditions).toHaveLength(0);
    for (const v of r.variants) expect(v.audioRenditionId).toBeNull();
  });

  it("master-audio-group.m3u8 → URI-bearing renditions + variant links", () => {
    const r = parseHlsMaster(fixture("master-audio-group.m3u8"), "https://x.test/master.m3u8");
    const exp = expected("master-audio-group.expected.json") as {
      variantCount: number;
      renditionCount: number;
      renditions: Array<{ audioRenditionId: string; playlistUrl: string }>;
      variantLinks: Array<{ height: number; audioRenditionId: string | null }>;
    };

    expect(r.variants).toHaveLength(exp.variantCount);
    expect(r.audioRenditions).toHaveLength(exp.renditionCount);

    for (const e of exp.renditions) {
      const rend = r.audioRenditions.find(a => a.audioRenditionId === e.audioRenditionId);
      expect(rend, `rendition ${e.audioRenditionId}`).toBeDefined();
      expect(rend?.videoCodec).toBeNull();
      expect(rend?.segmentRef).toMatchObject({
        kind: "hls-segments",
        playlistUrl: e.playlistUrl,
        initSegmentUrl: null,
        segmentUrls: [],
        encryption: null,
      });
    }

    for (const e of exp.variantLinks) {
      const v = r.variants.find(x => x.height === e.height);
      expect(v, `variant ${e.height}p`).toBeDefined();
      expect(v?.audioRenditionId).toBe(e.audioRenditionId);
    }
  });

  it("prefers the DEFAULT=YES rendition over the group's first listed one", () => {
    const r = parseHlsMaster(fixture("master-audio-group.m3u8"), "https://x.test/master.m3u8");
    // aud-hi lists French (DEFAULT=NO) before English (DEFAULT=YES).
    const v1080 = r.variants.find(v => v.height === 1080);
    expect(v1080?.audioRenditionId).toBe("aud-hi:English");
  });

  it("a group whose renditions carry no URI (muxed audio) links nothing", () => {
    const r = parseHlsMaster(fixture("master-audio-group.m3u8"), "https://x.test/master.m3u8");
    const v480 = r.variants.find(v => v.height === 480);
    expect(v480?.audioRenditionId).toBeNull();
    expect(r.audioRenditions.some(a => String(a.audioRenditionId).startsWith("aud-muxed:"))).toBe(false);
  });
});
