/**
 * HLS AES-128 decryption in the browser.
 *
 * The policy — which key shapes are allowed at all — lives in
 * `@savemedia/core` (`planHlsKeys`, `isClearAes128`, `segmentIv`): one
 * source of truth, unit tested, shared with classify and dispatch. This
 * module is only the part that needs a browser: fetching key bytes into a
 * WebCrypto key and decrypting segment bodies.
 */
import { AES_128_KEY_BYTES } from "@savemedia/core";

export type KeyFetcher = (keyUri: string) => Promise<Uint8Array>;

/**
 * Fetches and caches the AES-128 keys of one playlist. Keys may rotate per
 * segment, so the cache is keyed by URI and every miss is one fetch.
 */
export class HlsKeyring {
  private readonly keys = new Map<string, CryptoKey>();

  constructor(private readonly fetchKey: KeyFetcher) {}

  async keyFor(keyUri: string): Promise<CryptoKey> {
    const cached = this.keys.get(keyUri);
    if (cached) return cached;
    const bytes = await this.fetchKey(keyUri);
    if (bytes.byteLength !== AES_128_KEY_BYTES) {
      throw new KeyMaterialError(keyUri, bytes.byteLength);
    }
    const key = await crypto.subtle.importKey(
      "raw",
      bytes as unknown as ArrayBuffer,
      { name: "AES-CBC" },
      false,
      ["decrypt"],
    );
    this.keys.set(keyUri, key);
    return key;
  }
}

/** The URI answered, but not with a key: 16 bytes or it is not one. */
export class KeyMaterialError extends Error {
  constructor(readonly keyUri: string, readonly byteLength: number) {
    super(`key at ${keyUri} is ${byteLength} bytes, expected ${AES_128_KEY_BYTES}`);
    this.name = "KeyMaterialError";
  }
}

/**
 * One segment, decrypted. WebCrypto removes the PKCS#7 padding that HLS
 * mandates per segment, so the result is the plain MPEG-TS or fMP4 bytes
 * the rest of the pipeline already knows how to read.
 */
export async function decryptSegment(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: iv as unknown as ArrayBuffer },
    key,
    ciphertext as unknown as ArrayBuffer,
  );
  return new Uint8Array(plain);
}
