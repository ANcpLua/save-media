import { describe, expect, it } from "vitest";
import { isHostToExtensionMessage, localFailureText, LOCAL_FAILURE_CODES } from "../../../src/types/native";
import { isPopupToBackgroundMessage, isBackgroundToPopupMessage } from "../../../src/types/messages";

describe("host protocol guards", () => {
  it("accepts well-formed frames and rejects the rest", () => {
    expect(isHostToExtensionMessage({ type: "pong", hostVersion: "1", protocolVersion: 1, ytdlp: { found: false, version: null, path: null }, ffmpeg: { found: true, version: "7", path: "/f" }, outputDir: "/d" })).toBe(true);
    expect(isHostToExtensionMessage({ type: "progress", id: "a", phase: "merging", downloadedBytes: null, totalBytes: null, percent: 99.5, speedBytesPerSec: null, etaSeconds: 0 })).toBe(true);
    expect(isHostToExtensionMessage({ type: "progress", id: "a", phase: "uploading", downloadedBytes: null, totalBytes: null, percent: null, speedBytesPerSec: null, etaSeconds: null })).toBe(false);
    expect(isHostToExtensionMessage({ type: "failed", id: "a", code: "drm_protected", message: "m" })).toBe(true);
    expect(isHostToExtensionMessage({ type: "failed", id: "a", code: "bypassed", message: "m" })).toBe(false);
    expect(isHostToExtensionMessage(null)).toBe(false);
  });

  it("has user-facing text for every failure code", () => {
    for (const code of LOCAL_FAILURE_CODES) {
      const t = localFailureText(code, "");
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });
});

describe("popup local messages", () => {
  it("validates popup requests", () => {
    expect(isPopupToBackgroundMessage({ type: "local-status" })).toBe(true);
    expect(isPopupToBackgroundMessage({ type: "local-settings", patch: { quality: "720" } })).toBe(true);
    expect(isPopupToBackgroundMessage({ type: "local-settings", patch: { quality: "8k" } })).toBe(false);
    expect(isPopupToBackgroundMessage({ type: "local-download", tabId: null, pageUrl: "https://e.com" })).toBe(true);
    expect(isPopupToBackgroundMessage({ type: "local-download", tabId: "1", pageUrl: "https://e.com" })).toBe(false);
    expect(isPopupToBackgroundMessage({ type: "local-cancel", id: "x" })).toBe(true);
  });

  it("validates background responses", () => {
    expect(isBackgroundToPopupMessage({ type: "local-status", settings: {}, host: null, permissionGranted: false, jobs: [] })).toBe(true);
    expect(isBackgroundToPopupMessage({ type: "local-job", job: { id: "a", pageUrl: "u", tabId: null, phase: "probing", percent: null, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, filename: null, failure: null } })).toBe(true);
    expect(isBackgroundToPopupMessage({ type: "local-job", job: { id: "a" } })).toBe(false);
  });
});
