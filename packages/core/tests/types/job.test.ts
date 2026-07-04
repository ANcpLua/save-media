import { describe, expect, it } from "vitest";
import type { JobPlan, UserChoice, DispatchRefusal } from "../../src/types/job";

describe("job types", () => {
  it("UserChoice carries output mode + filename", () => {
    const choice: UserChoice = {
      outputMode: "Original",
      filename: "video.mp4",
      variantId: null,
      audioRenditionId: null,
    };
    expect(choice.outputMode).toBe("Original");
  });

  it("JobPlan discriminates by kind", () => {
    const direct: JobPlan = {
      kind: "direct",
      url: "https://example.com/v.mp4",
      filename: "v.mp4",
    };
    expect(direct.kind).toBe("direct");
  });

  it("JobPlan includes av-merge with two concrete merge tracks", () => {
    const merge: JobPlan = {
      kind: "av-merge",
      video: { initUrl: "https://example.com/init-v.mp4", segmentUrls: ["https://example.com/v1.m4s"] },
      audio: { initUrl: null, segmentUrls: ["https://example.com/a1.m4s"] },
      outputContainer: "mp4",
      outputFilename: "v.mp4",
      estimatedBytes: null,
    };
    expect(merge.kind).toBe("av-merge");
    if (merge.kind === "av-merge") expect(merge.audio.initUrl).toBeNull();
  });

  it("DispatchRefusal carries the DRM reason", () => {
    const refusal: DispatchRefusal = {
      kind: "refuse",
      reason: "cdm_required",
    };
    expect(refusal.reason).toBe("cdm_required");
  });
});
