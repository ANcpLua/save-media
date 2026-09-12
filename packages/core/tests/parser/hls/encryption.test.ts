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

  it("AES-128 behind a FairPlay KEYFORMAT → DRM-blocked, never decryptable", () => {
    // METHOD says AES-128, but the URI returns a licence a CDM unwraps, not
    // 16 key bytes. Boundary rule R1: this must not look decryptable.
    const parsed = parseHlsMediaPlaylist(fx("media-aes-128-fairplay.m3u8"), "https://x.test/m.m3u8");
    expect(parsed.encryption?.keyFormat).toBe("com.apple.streamingkeydelivery");
    const verdict = interpretHlsEncryption(parsed.encryption);
    expect(verdict.treatedAs).toBe("drm-blocked");
    expect(verdict.encryption).toBeNull();
    expect(verdict.drm?.reason).toBe("cdm_required");
    expect(verdict.drm?.keySystem).toBe("com.apple.streamingkeydelivery");
  });

  it("an identity KEYFORMAT spelled out is still a key in the clear", () => {
    const verdict = interpretHlsEncryption({
      method: "AES-128",
      uri: "https://keys.test/aes.key",
      iv: null,
      keyFormat: "identity",
    });
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
