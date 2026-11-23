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
    expect(r.sessionKeys).toEqual([]);

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

  // RFC 8216 4.3.4.2.1: a rendition without a URI is carried in the variant's own playlist.
  const mixed = (english: string, german: string): string => [
    "#EXTM3U",
    ...[english, german].sort((a, b) => Number(b.startsWith("first:")) - Number(a.startsWith("first:"))).map(line => line.replace("first:", "")),
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
    "main/prog.m3u8",
  ].join("\n");
  const ENGLISH_MUXED = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en"';
  const GERMAN_APART = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Deutsch",LANGUAGE="de",URI="de/prog.m3u8"';

  it("leaves a variant unlinked when its group's DEFAULT audio is muxed in and another language has a URI", () => {
    const r = parseHlsMaster(mixed(`${GERMAN_APART},DEFAULT=NO`, `${ENGLISH_MUXED},DEFAULT=YES`), "https://m.example/master.m3u8");
    // The variant is saved as it plays, with its own English audio; German stays listed as a rendition.
    expect(r.variants[0]?.audioRenditionId).toBeNull();
    expect(r.audioRenditions.map(a => a.audioRenditionId)).toEqual(["aud:Deutsch"]);
  });

  it("without a DEFAULT, the first listed rendition is the played one, with a URI or without", () => {
    const muxedFirst = parseHlsMaster(mixed(`first:${ENGLISH_MUXED}`, GERMAN_APART), "https://m.example/master.m3u8");
    expect(muxedFirst.variants[0]?.audioRenditionId).toBeNull();
    const apartFirst = parseHlsMaster(mixed(ENGLISH_MUXED, `first:${GERMAN_APART}`), "https://m.example/master.m3u8");
    expect(apartFirst.variants[0]?.audioRenditionId).toBe("aud:Deutsch");
  });

  it("links the DEFAULT rendition with a URI although a muxed rendition is listed first", () => {
    const r = parseHlsMaster(mixed(`first:${ENGLISH_MUXED},DEFAULT=NO`, `${GERMAN_APART},DEFAULT=YES`), "https://m.example/master.m3u8");
    expect(r.variants[0]?.audioRenditionId).toBe("aud:Deutsch");
  });
});
