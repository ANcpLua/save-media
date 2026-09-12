import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDash } from "../../../src/parser/dash/adapter";
import { dispatch } from "../../../src/engine/dispatch";
import { classify } from "../../../src/classifier/classify";
import type { UserChoice } from "../../../src/types/job";

const here = dirname(fileURLToPath(import.meta.url));
const mpd = readFileSync(resolve(here, "../../fixtures/dash/clear-video-audio.mpd"), "utf-8");
const MPD_URL = "https://x.test/dash-clear/clip.mpd";

const choice: UserChoice = {
  outputMode: "Original",
  filename: "out.mp4",
  variantId: null,
  audioRenditionId: null,
};

describe("clear DASH with SegmentTemplate video+audio", () => {
  it("materializes both AdaptationSets into fetchable init + segment URLs", () => {
    const parsed = parseDash(mpd, MPD_URL);

    expect(parsed.drm).toBeNull();
    expect(parsed.videoVariants).toHaveLength(1);
    expect(parsed.audioRenditions).toHaveLength(1);

    const video = parsed.videoVariants[0]!;
    expect(video.width).toBe(320);
    expect(video.height).toBe(180);
    expect(video.videoCodec?.family).toBe("h264");
    expect(video.segmentRef.kind).toBe("dash-segments");
    if (video.segmentRef.kind === "dash-segments") {
      expect(video.segmentRef.initUrl).toBe("https://x.test/dash-clear/init-stream0.m4s");
      expect(video.segmentRef.mediaUrls).toEqual([
        "https://x.test/dash-clear/chunk-stream0-00001.m4s",
        "https://x.test/dash-clear/chunk-stream0-00002.m4s",
      ]);
    }

    const audio = parsed.audioRenditions[0]!;
    expect(audio.audioCodec?.family).toBe("aac");
    if (audio.segmentRef.kind === "dash-segments") {
      expect(audio.segmentRef.initUrl).toBe("https://x.test/dash-clear/init-stream1.m4s");
      expect(audio.segmentRef.mediaUrls).toEqual([
        "https://x.test/dash-clear/chunk-stream1-00001.m4s",
        "https://x.test/dash-clear/chunk-stream1-00002.m4s",
      ]);
    }
  });

  it("dispatches to av-merge with both tracks, not to a refusal", async () => {
    const parsed = parseDash(mpd, MPD_URL);
    const descriptor = await classify({
      tabId: 1,
      pageUrl: "https://x.test/page/dash-clear.html",
      url: MPD_URL,
      headers: { "content-type": "application/dash+xml" },
      bodyBytes: null,
      manifestText: mpd,
    });

    expect(descriptor.protocol).toBe("dash");
    expect(descriptor.drm).toBeNull();

    const plan = dispatch(descriptor, choice);
    expect(plan.kind).toBe("av-merge");
    if (plan.kind !== "av-merge") return;
    expect(plan.video.initUrl).toBe(parsed.videoVariants[0]!.segmentRef.kind === "dash-segments"
      ? parsed.videoVariants[0]!.segmentRef.initUrl
      : null);
    expect(plan.video.segmentUrls.length).toBeGreaterThan(0);
    expect(plan.audio.segmentUrls.length).toBeGreaterThan(0);
    expect(plan.outputContainer).toBe("mp4");
  });
});
