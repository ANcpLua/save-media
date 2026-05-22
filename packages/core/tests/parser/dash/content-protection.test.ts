import { describe, expect, it } from "vitest";
import { classifyContentProtection } from "../../../src/parser/dash/content-protection";

describe("classifyContentProtection", () => {
  it("Widevine UUID → DRM-blocked with keySystem", () => {
    const v = classifyContentProtection([
      { schemeIdUri: "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", value: null },
    ]);
    expect(v.drm?.reason).toBe("cdm_required");
    expect(v.drm?.keySystem).toBe("com.widevine.alpha");
  });

  it("PlayReady UUID → DRM-blocked", () => {
    const v = classifyContentProtection([
      { schemeIdUri: "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", value: null },
    ]);
    expect(v.drm?.keySystem).toBe("com.microsoft.playready");
  });

  it("FairPlay UUID → DRM-blocked", () => {
    const v = classifyContentProtection([
      { schemeIdUri: "urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2", value: null },
    ]);
    expect(v.drm?.keySystem).toBe("com.apple.fps");
  });

  it("ClearKey UUID → clearkey_deferred", () => {
    const v = classifyContentProtection([
      { schemeIdUri: "urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e", value: null },
    ]);
    expect(v.drm?.reason).toBe("clearkey_deferred");
    expect(v.drm?.keySystem).toBe("org.w3.clearkey");
  });

  it("CENC-only schemeIdUri → null (decryptable in principle)", () => {
    const v = classifyContentProtection([
      { schemeIdUri: "urn:mpeg:dash:mp4protection:2011", value: "cenc" },
    ]);
    expect(v.drm).toBeNull();
  });

  it("no ContentProtection → null", () => {
    expect(classifyContentProtection([]).drm).toBeNull();
  });
});
