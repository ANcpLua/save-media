import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../../src/classifier/classify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(resolve(__dirname, `../fixtures/${n}`), "utf-8");

describe("classify orchestration", () => {
  it("progressive MP4: url+headers+bytes → mp4 confirmed", async () => {
    const ftyp = new Uint8Array(16);
    ftyp.set([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70]);
    ftyp.set(new TextEncoder().encode("isom"), 8);

    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn.example.com/v.mp4",
      headers: { "content-type": "video/mp4" },
      bodyBytes: ftyp,
      manifestText: null,
    });

    expect(d.protocol).toBe("progressive-http");
    expect(d.container).toBe("mp4");
    expect(d.confidence.container).toBe("confirmed");
    expect(d.drm).toBeNull();
    expect(d.capabilities.directDownload).toBe(true);
  });

  it("a DASH brand alone names a segment; a caller that found a whole file under it states so, and it is a direct file", async () => {
    const ftyp = new Uint8Array(16);
    ftyp.set([0, 0, 0, 0x10, 0x66, 0x74, 0x79, 0x70]);
    ftyp.set(new TextEncoder().encode("dash"), 8);
    const input = { tabId: 1, pageUrl: "https://example.com/page", url: "https://cdn.example.com/v.mp4",
      headers: { "content-type": "video/mp4" }, bodyBytes: ftyp, manifestText: null };

    const segment = await classify(input);
    expect(segment.container).toBe("fmp4");
    expect(segment.capabilities.directDownload).toBe(false);

    const file = await classify({ ...input, fileContainer: "mp4" });
    expect(file.protocol).toBe("progressive-http");
    expect(file.container).toBe("mp4");
    expect(file.confidence.container).toBe("confirmed");
    expect(file.capabilities.directDownload).toBe(true);
  });

  it(".mp4 URL alone is only a hint, not permission to download", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn.example.com/fake.mp4",
      headers: {},
      bodyBytes: null,
      manifestText: null,
    });

    expect(d.protocol).toBe("unknown");
    expect(d.container).toBe("mp4");
    expect(d.confidence.container).toBe("guessed");
    expect(d.capabilities.directDownload).toBe(false);
  });

  it("fake .mp4 returning HTML is not a direct download", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn.example.com/fake.mp4",
      headers: { "content-type": "text/html" },
      bodyBytes: new TextEncoder().encode("<html></html>"),
      manifestText: null,
    });

    expect(d.protocol).toBe("unknown");
    expect(d.capabilities.directDownload).toBe(false);
  });

  it("HLS master playlist → variants populated", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/master.m3u8",
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      bodyBytes: null,
      manifestText: fx("hls/master-vod-h264-aac.m3u8"),
    });
    expect(d.protocol).toBe("hls");
    expect(d.variants.length).toBe(3);
    expect(d.audioRenditions).toHaveLength(0);
    expect(d.drm).toBeNull();
  });

  it("HLS master with EXT-X-MEDIA audio groups surfaces renditions on the descriptor", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/master.m3u8",
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      bodyBytes: null,
      manifestText: fx("hls/master-audio-group.m3u8"),
    });
    expect(d.audioRenditions).toHaveLength(3);
    const v1080 = d.variants.find(v => v.height === 1080);
    expect(v1080?.audioRenditionId).toBe("aud-hi:English");
    expect(
      d.audioRenditions?.some(a => a.audioRenditionId === v1080?.audioRenditionId),
    ).toBe(true);
  });

  it("clear DASH MPD surfaces materialized video variants + audio renditions", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/m.mpd",
      headers: { "content-type": "application/dash+xml" },
      bodyBytes: null,
      manifestText: fx("dash/mpd-vod-multibitrate.mpd"),
    });
    expect(d.protocol).toBe("dash");
    expect(d.drm).toBeNull();
    expect(d.variants.length).toBeGreaterThanOrEqual(2);
    expect(d.audioRenditions).toHaveLength(1);
    const audioRef = d.audioRenditions?.[0]?.segmentRef;
    if (audioRef?.kind !== "dash-segments") throw new Error("expected dash-segments");
    expect(audioRef.initUrl).toBe("https://cdn/init-audio.m4s");
    expect(audioRef.mediaUrls.length).toBeGreaterThan(0);
  });

  it("HLS media playlist → single downloadable variant for the playlist itself", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/video/1080p.m3u8",
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      bodyBytes: null,
      manifestText: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:4.0,
seg-1.ts
#EXTINF:4.0,
seg-2.ts
#EXT-X-ENDLIST
`,
    });

    expect(d.protocol).toBe("hls");
    expect(d.source).toMatchObject({
      kind: "hls-manifest",
      manifestUrl: "https://cdn/video/1080p.m3u8",
      type: "media",
    });
    expect(d.container).toBe("mpegts");
    expect(d.variants).toHaveLength(1);
    expect(d.variants[0]?.segmentRef).toMatchObject({
      kind: "hls-segments",
      playlistUrl: "https://cdn/video/1080p.m3u8",
      initSegmentUrl: null,
      segmentUrls: [
        "https://cdn/video/seg-1.ts",
        "https://cdn/video/seg-2.ts",
      ],
      encryption: null,
    });
  });

  it("HLS fMP4 media playlist keeps EXT-X-MAP init segment with the variant", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/video/720p.av1.mp4.m3u8",
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      bodyBytes: null,
      manifestText: `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:5
#EXT-X-MAP:URI="720p.av1.mp4/init-v1-a1.mp4"
#EXTINF:4.0,
720p.av1.mp4/seg-1-v1-a1.mp4
#EXTINF:4.0,
720p.av1.mp4/seg-2-v1-a1.mp4
#EXT-X-ENDLIST
`,
    });

    expect(d.protocol).toBe("hls");
    expect(d.container).toBe("fmp4");
    expect(d.variants[0]?.segmentRef).toMatchObject({
      kind: "hls-segments",
      playlistUrl: "https://cdn/video/720p.av1.mp4.m3u8",
      initSegmentUrl: "https://cdn/video/720p.av1.mp4/init-v1-a1.mp4",
      segmentUrls: [
        "https://cdn/video/720p.av1.mp4/seg-1-v1-a1.mp4",
        "https://cdn/video/720p.av1.mp4/seg-2-v1-a1.mp4",
      ],
      encryption: null,
    });
  });

  describe("HLS keys at detection, by the one key policy", () => {
    const hls = (manifestText: string) => classify({
      tabId: 1, pageUrl: "https://example.com/page", url: "https://cdn/video/index.m3u8",
      headers: { "content-type": "application/vnd.apple.mpegurl" }, bodyBytes: null, manifestText,
    });

    it("AES-128 with a key served in the clear is decryptable, and its KEYFORMAT travels with the variant", async () => {
      const d = await hls(fx("hls/master-aes-128-reachable.m3u8"));
      expect(d.drm).toBeNull();
      expect(d.variants[0]?.segmentRef).toMatchObject({
        encryption: { method: "AES-128", keyUri: "https://keys.test/aes.key", keyFormat: "identity" },
      });
    });

    it.each([
      ["AES-128 behind a FairPlay KEYFORMAT", fx("hls/media-aes-128-fairplay.m3u8"), "com.apple.streamingkeydelivery"],
      ["SAMPLE-AES with a FairPlay KEYFORMAT", fx("hls/master-sample-aes-drm.m3u8"), "com.apple.streamingkeydelivery"],
      ["a later SAMPLE-AES key after a clear AES-128 key", `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXT-X-KEY:METHOD=AES-128,URI="k1"
#EXTINF:4.0,
a.ts
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k2"
#EXTINF:4.0,
b.ts
#EXT-X-ENDLIST
`, "SAMPLE-AES"],
    ])("%s is DRM before any Save", async (_name, text, keySystem) => {
      const d = await hls(text);
      expect(d.drm).toEqual({ reason: "cdm_required", detectedVia: ["hls-ext-x-key"], keySystem });
      expect(d.variants[0]?.segmentRef).toMatchObject({ encryption: null });
    });

    const master = (sessionKey: string) => `#EXTM3U
${sessionKey}
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080
1080.m3u8
`;

    it("a master whose EXT-X-SESSION-KEY names a CDM key system is DRM at detection", async () => {
      const d = await hls(master('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"'));
      expect(d.variants).toHaveLength(2);
      expect(d.drm).toEqual({ reason: "cdm_required", detectedVia: ["hls-ext-x-key"], keySystem: "com.apple.streamingkeydelivery" });
    });

    it("a master whose session key is AES-128 served in the clear stays saveable", async () => {
      const d = await hls(master('#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://keys.test/aes.key"'));
      expect(d.drm).toBeNull();
    });
  });

  it("DASH MPD with Widevine → cdm_required and no direct download", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/m.mpd",
      headers: { "content-type": "application/dash+xml" },
      bodyBytes: null,
      manifestText: fx("dash/mpd-widevine-drm.mpd"),
    });
    expect(d.protocol).toBe("dash");
    expect(d.drm?.reason).toBe("cdm_required");
    expect(d.capabilities).toEqual({ directDownload: false, remuxableTo: [] });
  });

  it("DASH MPD with ClearKey → clearkey_deferred and no direct download", async () => {
    const d = await classify({
      tabId: 1,
      pageUrl: "https://example.com/page",
      url: "https://cdn/m.mpd",
      headers: { "content-type": "application/dash+xml" },
      bodyBytes: null,
      manifestText: fx("dash/mpd-clearkey-deferred.mpd"),
    });
    expect(d.drm?.reason).toBe("clearkey_deferred");
    expect(d.capabilities).toEqual({ directDownload: false, remuxableTo: [] });
  });
});

describe("presentation: what a playlist or manifest states about its timeline", () => {
  const hls = (text: string) => classify({ tabId: 1, pageUrl: "https://p.test/", url: "https://cdn.test/v/media.m3u8",
    headers: { "content-type": "application/vnd.apple.mpegurl" }, bodyBytes: null, manifestText: text });

  it("a playlist with an end is not live and states its duration and target duration", async () => {
    const d = await hls("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:4.5,\na.ts\n#EXTINF:5.5,\nb.ts\n#EXT-X-ENDLIST\n");
    expect(d.presentation).toEqual({ live: false, durationSeconds: 10, maxSegmentSeconds: 6 });
  });

  it("a playlist without an end is live, an EVENT playlist included", async () => {
    expect((await hls("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:9\n#EXTINF:4,\na.ts\n")).presentation?.live).toBe(true);
    expect((await hls("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n")).presentation?.live).toBe(true);
  });

  it("falls back to the longest segment when no target duration is stated", async () => {
    expect((await hls("#EXTM3U\n#EXTINF:3,\na.ts\n#EXTINF:7,\nb.ts\n#EXT-X-ENDLIST\n")).presentation?.maxSegmentSeconds).toBe(7);
  });

  it("a master playlist states no timeline of its own", async () => {
    const d = await classify({ tabId: 1, pageUrl: "https://p.test/", url: "https://cdn.test/v/master.m3u8",
      headers: { "content-type": "application/vnd.apple.mpegurl" }, bodyBytes: null,
      manifestText: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nmedia.m3u8\n" });
    expect(d.presentation).toBeUndefined();
  });

  it("reads static and dynamic DASH", async () => {
    const dash = (attributes: string) => classify({ tabId: 1, pageUrl: "https://p.test/", url: "https://cdn.test/v/a.mpd",
      headers: { "content-type": "application/dash+xml" }, bodyBytes: null,
      manifestText: `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attributes} minBufferTime="PT1S"><Period>
        <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1000" width="640" height="360" codecs="avc1.64001f">
        <SegmentTemplate duration="2" timescale="1" media="s$Number$.m4s" initialization="i.mp4"/></Representation></AdaptationSet></Period></MPD>` });
    expect((await dash('type="static" mediaPresentationDuration="PT8S" maxSegmentDuration="PT3S"')).presentation)
      .toEqual({ live: false, durationSeconds: 8, maxSegmentSeconds: 3 });
    expect((await dash('type="static" mediaPresentationDuration="PT8S"')).presentation).toEqual({ live: false, durationSeconds: 8, maxSegmentSeconds: 2 });
    const live = await dash('type="dynamic" availabilityStartTime="2099-01-01T00:00:00Z" timeShiftBufferDepth="PT10S"');
    expect(live.presentation?.live).toBe(true);
    expect(live.presentation?.durationSeconds).toBeNull();
  });

  it("refuses a manifest that declares more segments than are read, before expanding it", async () => {
    await expect(classify({ tabId: 1, pageUrl: "https://p.test/", url: "https://evil.test/x.mpd",
      headers: { "content-type": "application/dash+xml" }, bodyBytes: null,
      manifestText: `<MPD type="static" mediaPresentationDuration="PT3H"><Period><AdaptationSet mimeType="video/mp4">
        <SegmentTemplate duration="1" timescale="1000" media="s$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>` }))
      .rejects.toMatchObject({ code: "manifest_too_large", limit: "segments" });
  });

  it("reads video/x-m4v as MP4", async () => {
    const d = await classify({ tabId: 1, pageUrl: "https://p.test/", url: "https://cdn.test/v/clip", headers: { "content-type": "video/x-m4v" },
      bodyBytes: null, manifestText: null });
    expect(d.container).toBe("mp4");
  });
});
