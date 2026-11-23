// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256 } from "../../../src/engine/crypto/sha256";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const expected = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("Sha256", () => {
  it("matches the published test vectors", () => {
    expect(hex(new Sha256().digest())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(new Sha256().update(new TextEncoder().encode("abc")).digest()))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(new Sha256().update(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).digest()))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("gives the same digest for every length around a block boundary", () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000]) {
      const data = new Uint8Array(randomBytes(length));
      expect(hex(new Sha256().update(data).digest()), `length ${length}`).toBe(expected(data));
    }
  });

  it("gives the same digest however the bytes are cut into pieces", () => {
    const data = new Uint8Array(randomBytes(300_000));
    for (const piece of [1, 7, 63, 64, 65, 4096, 100_000]) {
      const sha = new Sha256();
      for (let start = 0; start < data.length; start += piece) sha.update(data.subarray(start, start + piece));
      expect(hex(sha.digest()), `pieces of ${piece}`).toBe(expected(data));
    }
  });

  it("agrees with the browser's own digest", async () => {
    const data = new Uint8Array(randomBytes(1_000_003));
    const browser = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    expect(hex(new Sha256().update(data).digest())).toBe(hex(browser));
  });

  it("returns the same digest when asked twice and takes no more input afterwards", () => {
    const sha = new Sha256().update(new Uint8Array([1, 2, 3]));
    expect(hex(sha.digest())).toBe(hex(sha.digest()));
    expect(() => sha.update(new Uint8Array([4]))).toThrow();
  });
});
