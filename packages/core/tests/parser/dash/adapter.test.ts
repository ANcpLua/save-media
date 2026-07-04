import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDash } from "../../../src/parser/dash/adapter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(resolve(__dirname, `../../fixtures/dash/${n}`), "utf-8");

describe("parseDash", () => {
  it("VOD multi-bitrate yields 2 video + 1 audio representations", () => {
    const r = parseDash(fx("mpd-vod-multibitrate.mpd"), "https://x.test/m.mpd");
    expect(r.videoVariants.length).toBeGreaterThanOrEqual(2);
    expect(r.audioRenditions).toHaveLength(1);
    expect(r.drm).toBeNull();
  });

  it("materializes init + ordered media URLs for video variants", () => {
    const r = parseDash(fx("mpd-vod-multibitrate.mpd"), "https://x.test/m.mpd");
    const v720 = r.videoVariants.find(v => v.height === 720);
    expect(v720).toBeDefined();
    if (v720?.segmentRef.kind !== "dash-segments") throw new Error("expected dash-segments");
    expect(v720.segmentRef.initUrl).toBe("https://x.test/init-720p.m4s");
    // PT10M at 6s SegmentTemplate duration → 100 media segments.
    expect(v720.segmentRef.mediaUrls).toHaveLength(100);
    expect(v720.segmentRef.mediaUrls[0]).toBe("https://x.test/seg-720p-1.m4s");
    expect(v720.segmentRef.mediaUrls[99]).toBe("https://x.test/seg-720p-100.m4s");
  });

  it("materializes init + ordered media URLs for the audio rendition", () => {
    const r = parseDash(fx("mpd-vod-multibitrate.mpd"), "https://x.test/m.mpd");
    const audio = r.audioRenditions[0];
    expect(audio?.videoCodec).toBeNull();
    expect(audio?.audioCodec?.family).toBe("aac");
    if (audio?.segmentRef.kind !== "dash-segments") throw new Error("expected dash-segments");
    expect(audio.segmentRef.initUrl).toBe("https://x.test/init-audio.m4s");
    expect(audio.segmentRef.mediaUrls).toHaveLength(100);
    expect(audio.segmentRef.mediaUrls[0]).toBe("https://x.test/seg-audio-1.m4s");
  });

  it("estimates track sizes from bandwidth × total segment duration", () => {
    const r = parseDash(fx("mpd-vod-multibitrate.mpd"), "https://x.test/m.mpd");
    const v720 = r.videoVariants.find(v => v.height === 720);
    // 2_500_000 bit/s ÷ 8 × 600 s
    expect(v720?.estimatedSize).toBe(187_500_000);
    // 128_000 bit/s ÷ 8 × 600 s
    expect(r.audioRenditions[0]?.estimatedSize).toBe(9_600_000);
  });

  it("dynamic (live) MPD never materializes segment URLs", () => {
    // mpd-parser expands a dynamic MPD's *current availability window* into
    // segments; materializing those would let dispatch emit an av-merge plan
    // that saves a ~30s truncated file of a live stream and calls it success.
    const r = parseDash(fx("mpd-live-dynamic.mpd"), "https://x.test/live.mpd");
    expect(r.videoVariants.length).toBeGreaterThanOrEqual(1);
    expect(r.audioRenditions.length).toBeGreaterThanOrEqual(1);
    for (const v of [...r.videoVariants, ...r.audioRenditions]) {
      if (v.segmentRef.kind !== "dash-segments") throw new Error("expected dash-segments");
      expect(v.segmentRef.initUrl).toBe("");
      expect(v.segmentRef.mediaUrls).toHaveLength(0);
    }
    // Non-vacuity: mpd-parser DID expand a live window (the size estimate is
    // derived from those segments) — the empty refs above are the liveness
    // guard at work, not an empty parse.
    expect(r.videoVariants[0]?.estimatedSize).not.toBeNull();
  });

  it("Widevine MPD marks drm.cdm_required", () => {
    const r = parseDash(fx("mpd-widevine-drm.mpd"), "https://x.test/m.mpd");
    expect(r.drm?.reason).toBe("cdm_required");
    expect(r.drm?.keySystem).toBe("com.widevine.alpha");
  });

  it("ClearKey MPD marks drm.clearkey_deferred", () => {
    const r = parseDash(fx("mpd-clearkey-deferred.mpd"), "https://x.test/m.mpd");
    expect(r.drm?.reason).toBe("clearkey_deferred");
  });
});
