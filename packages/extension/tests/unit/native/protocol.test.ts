import { describe, expect, it } from "vitest";
import { NATIVE_PROTOCOL_VERSION, helperOutdated, isHostToExtensionMessage, type HostPong } from "../../../src/types/native";
import { parseBroadcast, parsePopupRequest } from "../../../src/types/messages";

const isPopupToBackgroundMessage = (value: unknown): boolean => parsePopupRequest(value) !== null;
const isBackgroundToPopupMessage = (value: unknown): boolean => parseBroadcast(value) !== null;

describe("host protocol guards", () => {
  it("accepts well-formed frames and rejects the rest", () => {
    expect(isHostToExtensionMessage({ type: "pong", hostVersion: "1", protocolVersion: 1, ytdlp: { found: false, version: null, path: null }, ffmpeg: { found: true, version: "7", path: "/f" }, outputDir: "/d" })).toBe(true);
    expect(isHostToExtensionMessage({ type: "progress", id: "a", phase: "merging", downloadedBytes: null, totalBytes: null, percent: 99.5, speedBytesPerSec: null, etaSeconds: 0 })).toBe(true);
    expect(isHostToExtensionMessage({ type: "progress", id: "a", phase: "uploading", downloadedBytes: null, totalBytes: null, percent: null, speedBytesPerSec: null, etaSeconds: null })).toBe(false);
    expect(isHostToExtensionMessage({ type: "failed", id: "a", code: "drm_protected", message: "m" })).toBe(true);
    expect(isHostToExtensionMessage({ type: "failed", id: "a", code: "bypassed", message: "m" })).toBe(false);
    expect(isHostToExtensionMessage(null)).toBe(false);
  });

  it("takes a helper of an earlier protocol as outdated, whatever version text it reports", () => {
    const pong = (protocolVersion: number, hostVersion = "1.3.0"): HostPong => ({ type: "pong", hostVersion, protocolVersion,
      ytdlp: { found: true, version: "x", path: "/x" }, ffmpeg: { found: true, version: "y", path: "/y" }, outputDir: "/d" });
    expect(NATIVE_PROTOCOL_VERSION).toBe(2);
    // Every helper published before this protocol, and the development copies of it, report protocol 1.
    expect(helperOutdated(pong(1, "1.1.0"))).toBe(true);
    expect(helperOutdated(pong(1, "1.3.0"))).toBe(true);
    expect(helperOutdated(pong(NATIVE_PROTOCOL_VERSION))).toBe(false);
    expect(helperOutdated(pong(NATIVE_PROTOCOL_VERSION + 1))).toBe(false);
  });

  it("knows no failure code that only an unpublished helper sent", () => {
    for (const code of ["cookie_store_missing", "origin_timeout"]) {
      expect(isHostToExtensionMessage({ type: "failed", id: "a", code, message: "m" })).toBe(false);
    }
  });

  it("accepts an HTTP status with a failure, within the range a status has", () => {
    expect(isHostToExtensionMessage({ type: "failed", id: "a", code: "unknown", message: "m", httpStatus: 403 })).toBe(true);
    expect(isHostToExtensionMessage({ type: "failed", id: "a", code: "unknown", message: "m", httpStatus: 9999 })).toBe(false);
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
