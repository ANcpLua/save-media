import type { DrmStatus } from "../../types/stream";

export interface ContentProtectionElement {
  readonly schemeIdUri: string;
  readonly value: string | null;
}

const KEY_SYSTEM_MAP: Record<string, { keySystem: string; deferred: boolean }> = {
  // CDM-bound
  "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": { keySystem: "com.widevine.alpha",    deferred: false },
  "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95": { keySystem: "com.microsoft.playready", deferred: false },
  "urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2": { keySystem: "com.apple.fps",          deferred: false },
  // ClearKey — both the W3C UUID (used by mpd-parser internally) and the DASH ClearKey UUID
  "urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": { keySystem: "org.w3.clearkey",        deferred: true },
  "urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e": { keySystem: "org.w3.clearkey",        deferred: true },
};

export interface ContentProtectionVerdict {
  readonly drm: DrmStatus;
}

export function classifyContentProtection(elements: readonly ContentProtectionElement[]): ContentProtectionVerdict {
  for (const el of elements) {
    const key = el.schemeIdUri.toLowerCase();
    const entry = KEY_SYSTEM_MAP[key];
    if (entry) {
      return {
        drm: {
          reason: entry.deferred ? "clearkey_deferred" : "cdm_required",
          detectedVia: entry.deferred
            ? ["dash-content-protection", "clearkey-detector"]
            : ["dash-content-protection"],
          keySystem: entry.keySystem,
        },
      };
    }
  }
  return { drm: null };
}
