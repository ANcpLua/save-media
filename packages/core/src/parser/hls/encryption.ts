import type { HlsEncryption } from "../../types/codec";
import type { DrmStatus } from "../../types/stream";

export type EncryptionTreatment = "clear" | "decryptable" | "drm-blocked";

export interface EncryptionVerdict {
  readonly treatedAs: EncryptionTreatment;
  readonly encryption: HlsEncryption | null;
  readonly drm: DrmStatus;
}

/**
 * METHOD alone does not decide this. AES-128 with KEYFORMAT
 * "com.apple.streamingkeydelivery" is FairPlay: the URI returns a licence,
 * not a key, and only a CDM can unwrap it. Only an identity KEYFORMAT (or
 * none, which means identity) is a key served in the clear, and only that
 * is decryptable — boundary rules G1 for the yes, R1 for the no.
 */
export function interpretHlsEncryption(
  raw: {
    readonly method: string;
    readonly uri: string;
    readonly iv: Uint8Array | null;
    readonly keyFormat?: string | null;
  } | null,
): EncryptionVerdict {
  if (raw === null) {
    return { treatedAs: "clear", encryption: null, drm: null };
  }

  const method = raw.method.toUpperCase();

  if (method === "NONE") {
    return { treatedAs: "clear", encryption: null, drm: null };
  }

  const keyFormat = (raw.keyFormat ?? "identity").toLowerCase();
  const identityKey = keyFormat === "identity" || keyFormat === "";

  if (method === "AES-128" && identityKey) {
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
      keySystem: identityKey ? null : keyFormat,
    },
  };
}
