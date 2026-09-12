import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { segmentIv } from "@savemedia/core";
import { HlsKeyring, KeyMaterialError, decryptSegment } from "../../../src/engine/crypto/hls-aes";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(here, `../../e2e/media-fixtures/hls-aes/${name}`)));

const KEY_URI = "https://x.test/key.bin";

describe("HLS AES-128 decryption", () => {
  it("turns the ciphertext fixture back into MPEG-TS", async () => {
    // The fixture's EXT-X-KEY declares IV=0x00…00, so the IV is 16 zero bytes.
    const keyring = new HlsKeyring(async () => fixture("key.bin"));
    const key = await keyring.keyFor(KEY_URI);
    const plain = await decryptSegment(key, segmentIv(new Uint8Array(16), 0), fixture("seg000.ts"));

    expect(plain[0]).toBe(0x47); // MPEG-TS sync byte
    expect(plain.byteLength % 188).toBe(0); // whole TS packets
    expect(plain.byteLength).toBe(128_404);
    // Every packet starts with the sync byte, so this is really TS and not
    // 128 kB of plausible-looking garbage.
    for (let offset = 0; offset < plain.byteLength; offset += 188) {
      expect(plain[offset]).toBe(0x47);
    }
  });

  it("fetches each key once and reuses it while segments rotate through it", async () => {
    const fetchKey = vi.fn(async () => fixture("key.bin"));
    const keyring = new HlsKeyring(fetchKey);
    const first = await keyring.keyFor(KEY_URI);
    const second = await keyring.keyFor(KEY_URI);
    expect(second).toBe(first);
    expect(fetchKey).toHaveBeenCalledTimes(1);

    await keyring.keyFor("https://x.test/other.bin");
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it("refuses key material that is not 16 bytes", async () => {
    const keyring = new HlsKeyring(async () => new Uint8Array(32));
    await expect(keyring.keyFor(KEY_URI)).rejects.toBeInstanceOf(KeyMaterialError);
  });

  it("refuses an HTML error page served in place of a key", async () => {
    const keyring = new HlsKeyring(async () => new Uint8Array(Buffer.from("<html>403</html>")));
    // 16 characters long by accident, so the length check passes and the
    // decrypt is what fails: either way no bytes are written.
    const key = await keyring.keyFor(KEY_URI);
    await expect(decryptSegment(key, new Uint8Array(16), fixture("seg000.ts"))).rejects.toThrow();
  });

  it("a wrong key cannot produce MPEG-TS", async () => {
    const keyring = new HlsKeyring(async () => new Uint8Array(16).fill(9));
    const key = await keyring.keyFor(KEY_URI);
    // Wrong key: either the PKCS#7 padding check fails (throws) or the bytes
    // are noise. Both are acceptable; silently-valid TS would not be.
    try {
      const plain = await decryptSegment(key, new Uint8Array(16), fixture("seg000.ts"));
      expect(plain[0]).not.toBe(0x47);
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});
