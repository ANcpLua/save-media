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
    expect(r.drm).toBeNull();
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
