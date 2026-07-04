import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { youtubeResolver } from "../../../../src/content/sites/youtube";

const playerResponse = readFileSync(
  resolve(process.cwd(), "tests/unit/content/sites/fixtures/youtube-player.json"),
  "utf-8",
);

function bodyWith(formats: readonly unknown[]): string {
  return JSON.stringify({ streamingData: { adaptiveFormats: formats } });
}

function h264(itag: number, height: number): Record<string, unknown> {
  return {
    itag,
    url: `https://rr1---sn-example.googlevideo.com/videoplayback?itag=${itag}&mime=video%2Fmp4`,
    mimeType: 'video/mp4; codecs="avc1.640028"',
    width: Math.round((height * 16) / 9),
    height,
    bitrate: height * 2000,
  };
}

function aac(): Record<string, unknown> {
  return {
    itag: 140,
    url: "https://rr1---sn-example.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4",
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 130268,
  };
}

/** Cipher-protected formats carry `signatureCipher` and no plain `url`. */
function ciphered(itag: number, mimeType: string): Record<string, unknown> {
  return {
    itag,
    mimeType,
    bitrate: 1_000_000,
    signatureCipher: "s=ZZaAbBcC%3D%3D&sp=sig&url=https%3A%2F%2Frr1---sn-example.googlevideo.com%2Fvideoplayback",
  };
}

describe("youtube resolver", () => {
  it("owns youtube.com / youtube-nocookie.com and their subdomains, not the CDN", () => {
    expect(youtubeResolver.ownsHost("youtube.com")).toBe(true);
    expect(youtubeResolver.ownsHost("www.youtube.com")).toBe(true);
    expect(youtubeResolver.ownsHost("m.youtube.com")).toBe(true);
    expect(youtubeResolver.ownsHost("www.youtube-nocookie.com")).toBe(true);
    expect(youtubeResolver.ownsHost("rr3---sn-4g5edned.googlevideo.com")).toBe(false);
    expect(youtubeResolver.ownsHost("notyoutube.com")).toBe(false);
    expect(youtubeResolver.ownsHost("x.com")).toBe(false);
  });

  it("matches only the InnerTube player endpoint", () => {
    expect(youtubeResolver.matchesApi("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")).toBe(true);
    expect(youtubeResolver.matchesApi("https://m.youtube.com/youtubei/v1/player?key=abc")).toBe(true);
    expect(youtubeResolver.matchesApi("https://www.youtube.com/youtubei/v1/browse")).toBe(false);
    expect(youtubeResolver.matchesApi("https://www.youtube.com/youtubei/v1/next")).toBe(false);
    expect(youtubeResolver.matchesApi("https://www.youtube.com/watch?v=aQb2eDW4kzA")).toBe(false);
  });

  it("emits one demuxed pair: best H.264 video itag + AAC itag 140", () => {
    const media = youtubeResolver.parse(playerResponse);

    expect(media).toHaveLength(1);
    const pair = media[0]!;
    expect(pair.site).toBe("youtube");
    // itag 137 (1080p avc1) wins over 136; VP9 (248) and the cipher-only
    // 4K entry (313) are never considered.
    expect(pair.url).toContain("itag=137");
    expect(pair.url).toContain("mime=video%2Fmp4");
    expect(pair.width).toBe(1920);
    expect(pair.height).toBe(1080);
    expect(pair.bitrate).toBe(4347552);
    expect(pair.audioUrl).toContain("itag=140");
    expect(pair.audioUrl).toContain("mime=audio%2Fmp4");
    // Signed URLs are re-minted on every player re-fetch; the pair's dedupe
    // identity must be the stable video id + itags, not the volatile URL.
    expect(pair.dedupeKey).toBe("youtube:aQb2eDW4kzA:137+140");
  });

  it("omits the dedupe key when videoDetails is missing instead of fabricating one", () => {
    const media = youtubeResolver.parse(bodyWith([h264(137, 1080), aac()]));
    expect(media).toHaveLength(1);
    expect(media[0]!.dedupeKey).toBeUndefined();
  });

  it("skips cipher-protected formats instead of attempting cipher solving", () => {
    // Best itag (137) is cipher-only → the next H.264 itag with a plain url wins.
    const media = youtubeResolver.parse(bodyWith([
      ciphered(137, 'video/mp4; codecs="avc1.640028"'),
      h264(136, 720),
      aac(),
    ]));
    expect(media).toHaveLength(1);
    expect(media[0]!.url).toContain("itag=136");
  });

  it("returns nothing when every H.264 video format is cipher-protected", () => {
    expect(youtubeResolver.parse(bodyWith([
      ciphered(137, 'video/mp4; codecs="avc1.640028"'),
      ciphered(136, 'video/mp4; codecs="avc1.4d401f"'),
      aac(),
    ]))).toEqual([]);
  });

  it("returns nothing when the AAC audio itag is missing or cipher-protected", () => {
    expect(youtubeResolver.parse(bodyWith([h264(137, 1080)]))).toEqual([]);
    expect(youtubeResolver.parse(bodyWith([
      h264(137, 1080),
      ciphered(140, 'audio/mp4; codecs="mp4a.40.2"'),
    ]))).toEqual([]);
  });

  it("returns nothing for VP9/Opus-only videos (WebM merge is a later story)", () => {
    expect(youtubeResolver.parse(bodyWith([
      { itag: 248, url: "https://rr1.googlevideo.com/videoplayback?itag=248", mimeType: 'video/webm; codecs="vp9"' },
      { itag: 251, url: "https://rr1.googlevideo.com/videoplayback?itag=251", mimeType: 'audio/webm; codecs="opus"' },
    ]))).toEqual([]);
  });

  it("returns nothing for non-JSON or media-free bodies", () => {
    expect(youtubeResolver.parse("<html>not json</html>")).toEqual([]);
    expect(youtubeResolver.parse(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED" } }))).toEqual([]);
  });
});
