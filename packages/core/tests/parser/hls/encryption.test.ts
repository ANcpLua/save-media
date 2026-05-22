import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHlsMediaPlaylist } from "../../../src/parser/hls/adapter";
import { interpretHlsEncryption } from "../../../src/parser/hls/encryption";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(resolve(__dirname, `../../fixtures/hls/${n}`), "utf-8");

describe("HLS encryption interpretation", () => {
  it("AES-128 with key URI → decryptable, not DRM", () => {
    const parsed = parseHlsMediaPlaylist(fx("master-aes-128-reachable.m3u8"), "https://x.test/m.m3u8");
    const verdict = interpretHlsEncryption(parsed.encryption);
    expect(verdict.treatedAs).toBe("decryptable");
    expect(verdict.drm).toBeNull();
  });

  it("SAMPLE-AES → DRM-blocked", () => {
    const parsed = parseHlsMediaPlaylist(fx("master-sample-aes-drm.m3u8"), "https://x.test/m.m3u8");
    const verdict = interpretHlsEncryption(parsed.encryption);
    expect(verdict.treatedAs).toBe("drm-blocked");
    const drm = verdict.drm;
    expect(drm).not.toBeNull();
    if (drm !== null) {
      expect(drm.reason).toBe("cdm_required");
    }
  });

  it("no encryption → null", () => {
    expect(interpretHlsEncryption(null).treatedAs).toBe("clear");
  });
});
