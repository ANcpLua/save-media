import type { DrmStatus } from "../../types/stream";

export interface ContentProtectionElement {
  readonly schemeIdUri: string;
  readonly value: string | null;
}

/** Names of the key systems a scheme UUID belongs to. The table only names; it never decides. */
const KEY_SYSTEMS: Readonly<Record<string, { readonly keySystem: string; readonly clearKey: boolean }>> = {
  "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": { keySystem: "com.widevine.alpha", clearKey: false },
  "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95": { keySystem: "com.microsoft.playready", clearKey: false },
  "urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2": { keySystem: "com.apple.fps", clearKey: false },
  // ClearKey: the W3C UUID (mpd-parser's) and the DASH-IF UUID.
  "urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": { keySystem: "org.w3.clearkey", clearKey: true },
  "urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e": { keySystem: "org.w3.clearkey", clearKey: true },
};

/** The key system a protection SystemID (a pssh box, a urn:uuid scheme) names; unnamed systems keep their urn. */
export function keySystemForUuid(uuid: string): string {
  const scheme = `urn:uuid:${uuid.toLowerCase()}`;
  return KEY_SYSTEMS[scheme]?.keySystem ?? scheme;
}

/** ISO/IEC 23009-1 5.8.5.2: the content is Common Encryption protected; `value` names the scheme. */
const MP4_PROTECTION = "urn:mpeg:dash:mp4protection:2011";

export interface ContentProtectionVerdict {
  readonly drm: DrmStatus;
}

/**
 * A ContentProtection element states that the media is encrypted, whatever
 * scheme it names. Its absence is the only clear verdict. A named CDM system
 * wins over ClearKey; any other scheme (the generic mp4protection element, or
 * a key system this table does not name) is a CDM key system as well.
 */
export function classifyContentProtection(elements: readonly ContentProtectionElement[]): ContentProtectionVerdict {
  if (elements.length === 0) return { drm: null };
  const schemes = elements.map(el => ({ scheme: el.schemeIdUri.toLowerCase(), value: el.value }));
  const named = schemes.map(({ scheme }) => KEY_SYSTEMS[scheme]).filter(entry => entry !== undefined);
  const cdm = named.find(entry => !entry.clearKey);
  if (cdm) return { drm: { reason: "cdm_required", detectedVia: ["dash-content-protection"], keySystem: cdm.keySystem } };
  const other = schemes.find(({ scheme }) => scheme !== MP4_PROTECTION && !KEY_SYSTEMS[scheme]);
  if (!other && named.length > 0) {
    return { drm: { reason: "clearkey_deferred", detectedVia: ["dash-content-protection", "clearkey-detector"], keySystem: "org.w3.clearkey" } };
  }
  const generic = schemes.find(({ scheme }) => scheme === MP4_PROTECTION);
  return {
    drm: {
      reason: "cdm_required",
      detectedVia: ["dash-content-protection"],
      keySystem: other?.scheme ?? generic?.value?.toLowerCase() ?? null,
    },
  };
}
