import { describe, expect, it } from "vitest";
import { dispatch } from "../../src/engine/dispatch";
import type { StreamDescriptor, StreamId } from "../../src/types/stream";
import type { UserChoice } from "../../src/types/job";

function makeDirect(): StreamDescriptor {
  return {
    id: "s1" as StreamId,
    tabId: 1,
    pageUrl: "https://x",
    title: "v",
    detectedAt: 0,
    source: { kind: "direct-url", url: "https://x/v.mp4", headers: {} },
    protocol: "progressive-http",
    container: "mp4",
    codecs: { video: null, audio: null, subtitles: [] },
    variants: [],
    drm: null,
    capabilities: { directDownload: true, remuxableTo: ["mp4"], transcodeableTo: ["mp4", "webm"], drmBlocked: false },
    confidence: { protocol: "confirmed", container: "confirmed", codecs: "guessed" },
  };
}

const choice: UserChoice = { outputMode: "Original", filename: "v.mp4", variantId: null, audioRenditionId: null };

describe("dispatch", () => {
  it("DRM-blocked descriptor returns DispatchRefusal", () => {
    const d = makeDirect();
    const drmDescriptor: StreamDescriptor = {
      ...d,
      drm: { reason: "cdm_required", detectedVia: ["eme-hook"], keySystem: "com.widevine.alpha" },
      capabilities: { ...d.capabilities, drmBlocked: true },
    };
    const r = dispatch(drmDescriptor, choice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("cdm_required");
  });

  it("direct progressive + Original → DirectPlan", () => {
    const r = dispatch(makeDirect(), choice);
    expect(r.kind).toBe("direct");
    if (r.kind === "direct") {
      expect(r.url).toBe("https://x/v.mp4");
      expect(r.filename).toBe("v.mp4");
    }
  });

  it("ClearKey-deferred returns DispatchRefusal with clearkey_deferred reason", () => {
    const d = makeDirect();
    const ckDescriptor: StreamDescriptor = {
      ...d,
      protocol: "dash",
      drm: { reason: "clearkey_deferred", detectedVia: ["dash-content-protection", "clearkey-detector"], keySystem: "org.w3.clearkey" },
      capabilities: { ...d.capabilities, drmBlocked: true },
    };
    const r = dispatch(ckDescriptor, choice);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.reason).toBe("clearkey_deferred");
  });
});
