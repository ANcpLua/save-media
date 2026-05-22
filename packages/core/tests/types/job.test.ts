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

  it("DispatchRefusal carries the DRM reason", () => {
    const refusal: DispatchRefusal = {
      kind: "refuse",
      reason: "cdm_required",
    };
    expect(refusal.reason).toBe("cdm_required");
  });
});
