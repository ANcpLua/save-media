import type { HlsEncryption } from "../../types/codec";
import type { DrmStatus } from "../../types/stream";

export type EncryptionTreatment = "clear" | "decryptable" | "drm-blocked";

export interface EncryptionVerdict {
  readonly treatedAs: EncryptionTreatment;
  readonly encryption: HlsEncryption | null;
  readonly drm: DrmStatus;
}

export function interpretHlsEncryption(
  raw: { readonly method: string; readonly uri: string; readonly iv: Uint8Array | null } | null,
): EncryptionVerdict {
  if (raw === null) {
    return { treatedAs: "clear", encryption: null, drm: null };
  }

  const method = raw.method.toUpperCase();

  if (method === "NONE") {
    return { treatedAs: "clear", encryption: null, drm: null };
  }

  if (method === "AES-128") {
    return {
      treatedAs: "decryptable",
      encryption: { method: "AES-128", keyUri: raw.uri, iv: raw.iv },
      drm: null,
    };
  }

  return {
    treatedAs: "drm-blocked",
    encryption: null,
    drm: {
      reason: "cdm_required",
      detectedVia: ["hls-ext-x-key"],
      keySystem: null,
    },
  };
}
