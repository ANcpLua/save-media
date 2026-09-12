/**
 * EXT-X-KEY declarations, read from the playlist text.
 *
 * m3u8-parser reduces a key tag to method/uri/iv and drops KEYFORMAT, and
 * KEYFORMAT is exactly what separates a key the server hands over in the
 * clear (identity, boundary rule G1: allowed) from one only a CDM can
 * unwrap (FairPlay's com.apple.streamingkeydelivery, Widevine's URN —
 * rule R1: never). So the tags are parsed here instead.
 *
 * Pure policy: no fetching, no decryption. The engine owns those.
 */

/** KEYFORMAT values that mean "the URI answers with the raw key bytes". */
const IDENTITY_KEY_FORMATS = new Set(["identity", ""]);

export const AES_128_KEY_BYTES = 16;

export interface HlsKeyDeclaration {
  /** Uppercased METHOD: NONE, AES-128, SAMPLE-AES, SAMPLE-AES-CTR, … */
  readonly method: string;
  /** Absolute key URI; null for METHOD=NONE or a tag without URI. */
  readonly keyUri: string | null;
  /** KEYFORMAT lowercased; "identity" when the tag omits it. */
  readonly keyFormat: string;
  /** IV attribute as 16 bytes, null when the tag omits it. */
  readonly iv: Uint8Array | null;
}

export type HlsKeyPlan =
  | { readonly kind: "clear" }
  | { readonly kind: "aes-128" }
  | { readonly kind: "drm"; readonly keySystem: string };

export function isClearAes128(declaration: HlsKeyDeclaration): boolean {
  return declaration.method === "AES-128"
    && IDENTITY_KEY_FORMATS.has(declaration.keyFormat)
    && declaration.keyUri !== null;
}

/**
 * What a playlist's key tags mean for us. Every active declaration must be
 * supported: one SAMPLE-AES tag in an otherwise AES-128 playlist makes the
 * whole thing undecryptable, because those segments stay locked.
 */
export function planHlsKeys(declarations: readonly HlsKeyDeclaration[]): HlsKeyPlan {
  const active = declarations.filter(d => d.method !== "NONE");
  if (active.length === 0) return { kind: "clear" };
  const unsupported = active.find(d => !isClearAes128(d));
  if (unsupported) {
    return {
      kind: "drm",
      keySystem: unsupported.method === "AES-128" ? unsupported.keyFormat : unsupported.method,
    };
  }
  return { kind: "aes-128" };
}

export function parseHlsKeyDeclarations(manifestText: string, manifestUrl: string): HlsKeyDeclaration[] {
  const declarations: HlsKeyDeclaration[] = [];
  for (const line of manifestText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#EXT-X-KEY:")) continue;
    const attributes = parseAttributeList(trimmed.slice("#EXT-X-KEY:".length));
    const uri = attributes.get("URI");
    declarations.push({
      method: (attributes.get("METHOD") ?? "AES-128").toUpperCase(),
      keyUri: uri ? absolute(uri, manifestUrl) : null,
      keyFormat: (attributes.get("KEYFORMAT") ?? "identity").toLowerCase(),
      iv: parseIvAttribute(attributes.get("IV")),
    });
  }
  return declarations;
}

/**
 * RFC 8216 section 5.2: without an IV attribute the media sequence number
 * is the IV, as a 128-bit big-endian integer.
 */
export function segmentIv(declaredIv: Uint8Array | null, mediaSequence: number | null): Uint8Array {
  if (declaredIv && declaredIv.byteLength === AES_128_KEY_BYTES) return declaredIv;
  const iv = new Uint8Array(AES_128_KEY_BYTES);
  let value = Math.max(0, Math.floor(mediaSequence ?? 0));
  for (let byte = AES_128_KEY_BYTES - 1; byte >= 0 && value > 0; byte--) {
    iv[byte] = value % 256;
    value = Math.floor(value / 256);
  }
  return iv;
}

/** An AES-128 segment is whole CBC blocks and nothing else. */
export function isDecryptableLength(byteLength: number): boolean {
  return byteLength > 0 && byteLength % AES_128_KEY_BYTES === 0;
}

/** NAME=VALUE pairs, comma separated, values optionally double quoted (RFC 8216 section 4.2). */
function parseAttributeList(list: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(list)) !== null) {
    attributes.set(match[1]!.toUpperCase(), (match[2] ?? match[3] ?? "").trim());
  }
  return attributes;
}

function parseIvAttribute(value: string | undefined): Uint8Array | null {
  if (!value) return null;
  const hex = value.replace(/^0[xX]/, "");
  if (hex.length !== AES_128_KEY_BYTES * 2 || /[^0-9a-fA-F]/.test(hex)) return null;
  const iv = new Uint8Array(AES_128_KEY_BYTES);
  for (let i = 0; i < AES_128_KEY_BYTES; i++) {
    iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return iv;
}

function absolute(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}
