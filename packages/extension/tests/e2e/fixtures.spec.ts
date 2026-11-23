import { test, expect } from "@playwright/test";

/**
 * Smoke-level e2e: load each fixture page and assert the fixture server
 * served the expected media payload. The full extension-under-load tests
 * (popup detection counts, click → download, DRM refusal cards) require
 * the extension to be present and the build artifact to be loaded —
 * those run in the chromium project where launchOptions injects the
 * unpacked extension. CI must skip them when the extension build is
 * missing.
 */

test.describe("fixture server", () => {
  test("serves the direct MP4 fixture page", async ({ page }) => {
    await page.goto("/page/direct.html");
    const src = await page.locator("video").getAttribute("src");
    expect(src).toBe("/direct/clip.mp4");
    const response = await page.request.get("/direct/clip.mp4");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("video/mp4");
  });

  test("serves the HLS master + media playlists", async ({ page }) => {
    await page.goto("/page/hls.html");
    const master = await page.request.get("/hls/master.m3u8");
    expect(master.status()).toBe(200);
    const masterText = await master.text();
    expect(masterText).toContain("EXT-X-STREAM-INF");
    expect(masterText).toContain("media.m3u8");
    const media = await page.request.get("/hls/media.m3u8");
    const mediaText = await media.text();
    expect(mediaText).toContain("seg000.ts");
    expect(mediaText).toContain("EXT-X-ENDLIST");
  });

  test("serves the HLS live fixture without EXT-X-ENDLIST", async ({ page }) => {
    await page.goto("/page/hls-live.html");
    const media = await page.request.get("/hls-live/media.m3u8");
    const mediaText = await media.text();
    expect(mediaText).toContain("seg000.ts");
    expect(mediaText).not.toContain("EXT-X-ENDLIST");
  });

  test("serves the HLS fMP4 playlist with EXT-X-MAP init segment", async ({ page }) => {
    await page.goto("/page/hls-fmp4.html");
    const media = await page.request.get("/hls-fmp4/media.m3u8");
    const text = await media.text();
    expect(text).toContain("EXT-X-MAP");
    expect(text).toContain("init.mp4");
    expect(text).toContain("seg000.m4s");
  });

  test("serves the demuxed HLS fixture with an EXT-X-MEDIA audio group", async ({ page }) => {
    await page.goto("/page/av-merge.html");
    const master = await page.request.get("/av-merge/master.m3u8");
    expect(master.status()).toBe(200);
    expect(master.headers()["content-type"]).toContain("mpegurl");
    const masterText = await master.text();
    expect(masterText).toContain("#EXT-X-MEDIA:TYPE=AUDIO");
    expect(masterText).toContain('URI="audio.m3u8"');
    expect(masterText).toContain('AUDIO="aud"');
    expect(masterText).toContain("video.m3u8");
    const video = await (await page.request.get("/av-merge/video.m3u8")).text();
    expect(video).toContain('EXT-X-MAP:URI="video-init.mp4"');
    expect(video).toContain("video-seg000.m4s");
    expect(video).toContain("EXT-X-ENDLIST");
    const audio = await (await page.request.get("/av-merge/audio.m3u8")).text();
    expect(audio).toContain('EXT-X-MAP:URI="audio-init.mp4"');
    expect(audio).toContain("audio-seg000.m4s");
    expect(audio).toContain("EXT-X-ENDLIST");
    for (const path of ["/av-merge/video-init.mp4", "/av-merge/audio-init.mp4"]) {
      expect((await page.request.get(path)).headers()["content-type"]).toContain("video/mp4");
    }
    for (const path of ["/av-merge/video-seg000.m4s", "/av-merge/video-seg001.m4s", "/av-merge/audio-seg000.m4s", "/av-merge/audio-seg001.m4s"]) {
      expect((await page.request.get(path)).headers()["content-type"]).toContain("video/iso.segment");
    }
  });

  test("serves the HLS AES-128 fixture with a reachable 16-byte key", async ({ page }) => {
    await page.goto("/page/hls-aes.html");
    const playlist = await page.request.get("/hls-aes/media.m3u8");
    expect(await playlist.text()).toContain("METHOD=AES-128");
    const key = await page.request.get("/hls-aes/key.bin");
    expect(Number(key.headers()["content-length"])).toBe(16);
  });

  test("serves the clear DASH packaging: static MPD, SegmentTemplate, init and chunk bytes", async ({ page }) => {
    await page.goto("/page/dash-clear.html");
    const mpd = await page.request.get("/dash-clear/clip.mpd");
    expect(mpd.headers()["content-type"]).toContain("application/dash+xml");
    const text = await mpd.text();
    expect(text).toContain('type="static"');
    expect(text).toContain("<SegmentTemplate");
    expect(text).not.toContain("<SegmentBase");
    expect(text).not.toContain("<ContentProtection");
    expect(text).toContain('mimeType="video/mp4"');
    expect(text).toContain('mimeType="audio/mp4"');
    // Real bytes for both streams, not a manifest pointing at nothing.
    for (const name of ["init-stream0.m4s", "chunk-stream0-00001.m4s", "init-stream1.m4s", "chunk-stream1-00001.m4s"]) {
      const segment = await page.request.get(`/dash-clear/${name}`);
      expect(segment.status(), name).toBe(200);
      expect((await segment.body()).byteLength, name).toBeGreaterThan(100);
    }
  });

  test("serves a DASH MPD whose byte ranges leave a gap for detection and refusal, and not the file it names", async ({ page }) => {
    await page.goto("/page/dash.html");
    const mpd = await page.request.get("/dash/clip.mpd");
    const text = await mpd.text();
    expect(text).toContain("SegmentList");
    expect([...text.matchAll(/(?:range|mediaRange)="(\d+)-(\d+)"/g)].map(match => [Number(match[1]), Number(match[2])]))
      .toEqual([[0, 799], [800, 49999], [60000, 99999]]);
    expect(text).not.toContain("ContentProtection");
    expect((await page.request.get("/dash/video.mp4")).status()).toBe(404);
  });

  for (const [name, file, header] of [["hls-single-file-fmp4", "clip.mp4", true], ["hls-single-file-ts", "clip.ts", false]] as const) {
    test(`serves an HLS playlist whose byte ranges cover one file from its first byte to its last (${name})`, async ({ page }) => {
      await page.goto(`/page/${name}.html`);
      const playlist = await (await page.request.get(`/${name}/media.m3u8`)).text();
      expect(playlist).toContain("#EXT-X-ENDLIST");
      expect(playlist).not.toContain("#EXT-X-KEY");
      // Every address is the one file.
      expect([...new Set(playlist.split("\n").filter(line => line && !line.startsWith("#")))]).toEqual([file]);
      const ranges = [...playlist.matchAll(/BYTERANGE[:=]"?(\d+)@(\d+)/g)].map(match => ({ offset: Number(match[2]), length: Number(match[1]) }));
      expect(ranges).toHaveLength(header ? 4 : 3);
      let end = 0;
      for (const range of ranges) {
        expect(range.offset, "each range starts where the one before it ends").toBe(end);
        end += range.length;
      }
      expect((await (await page.request.get(`/${name}/${file}`)).body()).byteLength).toBe(end);
    });
  }

  test("serves a real clear DASH packaging kept in one file per track, under two manifests", async ({ page }) => {
    await page.goto("/page/dash-single-file.html");
    const ranges = await (await page.request.get("/dash-single-file/clip.mpd")).text();
    const indexed = await (await page.request.get("/dash-single-file/on-demand.mpd")).text();
    for (const text of [ranges, indexed]) {
      expect(text).toContain('type="static"');
      expect(text).not.toContain("ContentProtection");
      expect(text).not.toContain("SegmentTemplate");
      expect(text).toContain("<BaseURL>clip-stream0.mp4</BaseURL>");
      expect(text).toContain("<BaseURL>clip-stream1.mp4</BaseURL>");
    }
    expect(ranges).toContain("mediaRange");
    expect(indexed).toContain("<SegmentBase indexRange=");
    for (const name of ["clip-stream0.mp4", "clip-stream1.mp4"]) {
      const file = await (await page.request.get(`/dash-single-file/${name}`)).body();
      // A header, then the index the on-demand manifest points at, then movie fragments.
      expect(file.subarray(4, 8).toString("latin1"), name).toBe("ftyp");
      expect(file.includes(Buffer.from("sidx")) && file.includes(Buffer.from("moof")), name).toBe(true);
    }
  });

  test("serves one fragmented MP4 file under the dash brand", async ({ page }) => {
    await page.goto("/page/dash-brand-file.html");
    const file = await (await page.request.get("/direct/clip-dash-brand.mp4")).body();
    expect(file.subarray(4, 12).toString("latin1")).toBe("ftypdash");
    expect(file.includes(Buffer.from("moof"))).toBe(true);
  });

  test("serves a real clear DASH packaging that declares no audio", async ({ page }) => {
    await page.goto("/page/dash-video-only.html");
    const text = await (await page.request.get("/dash-video-only/clip.mpd")).text();
    expect(text).toContain('type="static"');
    expect(text).toContain("SegmentTemplate");
    expect(text).toContain('contentType="video"');
    expect(text).not.toMatch(/contentType="audio"|mimeType="audio/);
    expect(text).not.toContain("ContentProtection");
    for (const name of ["init-stream0.m4s", "chunk-stream0-00001.m4s", "chunk-stream0-00002.m4s"]) {
      const segment = await page.request.get(`/dash-video-only/${name}`);
      expect(segment.status(), name).toBe(200);
      expect((await segment.body()).byteLength, name).toBeGreaterThan(100);
    }
  });

  for (const [name, segment] of [["hls-multi", "ts"], ["hls-aes-multi", "ts"], ["hls-fmp4-multi", "m4s"]] as const) {
    test(`serves the ${name} playlist with three different segments from media sequence 7`, async ({ page }) => {
      await page.goto(`/page/${name}.html`);
      const playlist = await (await page.request.get(`/${name}/media.m3u8`)).text();
      expect(playlist).toContain("#EXT-X-MEDIA-SEQUENCE:7");
      expect(playlist).toContain("#EXT-X-ENDLIST");
      // The AES playlist names its key and no IV: each segment's IV is its media sequence number.
      expect(/#EXT-X-KEY:METHOD=AES-128,URI="key\.bin"$/m.test(playlist)).toBe(name === "hls-aes-multi");
      expect(playlist).not.toContain("IV=");
      const names = playlist.split("\n").filter(line => line.endsWith(`.${segment}`));
      expect(names).toEqual([7, 8, 9].map(n => `seg00${n}.${segment}`));
      const bodies = await Promise.all(names.map(async file => (await (await page.request.get(`/${name}/${file}`)).body()).toString("base64")));
      expect(new Set(bodies).size).toBe(3);
    });
  }

  test("widevine MPD has the Widevine UUID in ContentProtection", async ({ page }) => {
    await page.goto("/page/widevine.html");
    const mpd = await page.request.get("/drm/widevine.mpd");
    expect(await mpd.text()).toContain("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed");
  });

  test("clearkey MPD uses the DASH-IF ClearKey UUID", async ({ page }) => {
    await page.goto("/page/clearkey.html");
    const mpd = await page.request.get("/drm/clearkey.mpd");
    expect(await mpd.text()).toContain("e2719d58-a985-b3c9-781a-b030af78d30e");
  });

  test("negative page returns non-media assets that classification must ignore", async ({ page }) => {
    await page.goto("/page/negative.html");
    for (const path of [
      "/negative/asset.jpg",
      "/negative/asset.jpeg",
      "/negative/asset.png",
      "/negative/page.html",
      "/negative/asset.css",
      "/negative/asset.js",
      "/negative/asset.gif",
      "/negative/asset.mp3",
      "/negative/asset.m4a",
    ]) {
      const r = await page.request.get(path);
      expect(r.status()).toBe(200);
      const ct = r.headers()["content-type"] ?? "";
      expect(ct).not.toContain("video");
      expect(ct).not.toContain("mpegurl");
    }
  });

  test("low fixture page exposes a sub-720p direct video", async ({ page }) => {
    await page.goto("/page/low.html");
    const r = await page.request.get("/low/clip.mp4");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("video/mp4");
  });
});
