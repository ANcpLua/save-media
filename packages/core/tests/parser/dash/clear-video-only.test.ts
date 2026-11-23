import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDash } from "../../../src/parser/dash/adapter";
import { dispatch } from "../../../src/engine/dispatch";
import { classify } from "../../../src/classifier/classify";
import type { UserChoice } from "../../../src/types/job";

// The manifest the e2e serves under /dash/: a muted clip, published with a
// video AdaptationSet and no audio at all. It is clear media the browser
// receives, so it is saved, with its picture alone.
const here = dirname(fileURLToPath(import.meta.url));
const mpd = readFileSync(resolve(here, "../../fixtures/dash/clear-video-only.mpd"), "utf-8");
const MPD_URL = "https://x.test/dash/clip.mpd";

const choice: UserChoice = { outputMode: "Original", filename: "out.mp4", variantId: null, audioRenditionId: null };

describe("clear DASH that declares no audio", () => {
  it("materializes the video AdaptationSet and no audio rendition", () => {
    const parsed = parseDash(mpd, MPD_URL);
    expect(parsed.drm).toBeNull();
    expect(parsed.presentation.live).toBe(false);
    expect(parsed.audioRenditions).toEqual([]);
    expect(parsed.videoVariants).toHaveLength(1);
    expect(parsed.videoVariants[0]!.segmentRef).toEqual({
      kind: "dash-segments",
      initUrl: "https://x.test/dash/init-stream0.m4s",
      mediaUrls: ["https://x.test/dash/chunk-stream0-00001.m4s", "https://x.test/dash/chunk-stream0-00002.m4s"],
    });
  });

  it("is classified as clear and dispatched to a save of the video track alone", async () => {
    const descriptor = await classify({
      tabId: 1,
      pageUrl: "https://x.test/page/dash.html",
      url: MPD_URL,
      headers: { "content-type": "application/dash+xml" },
      bodyBytes: null,
      manifestText: mpd,
    });
    expect(descriptor.protocol).toBe("dash");
    expect(descriptor.drm).toBeNull();
    expect(dispatch(descriptor, choice)).toEqual({
      kind: "av-merge",
      video: {
        initUrl: "https://x.test/dash/init-stream0.m4s",
        segmentUrls: ["https://x.test/dash/chunk-stream0-00001.m4s", "https://x.test/dash/chunk-stream0-00002.m4s"],
      },
      audio: null,
      outputContainer: "mp4",
      outputFilename: "out.mp4",
      estimatedBytes: expect.any(Number),
    });
  });
});
