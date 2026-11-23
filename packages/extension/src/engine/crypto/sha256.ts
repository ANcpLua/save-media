/**
 * SHA-256 over bytes that arrive in pieces. The browser's own digest
 * (crypto.subtle) takes the whole input as one buffer, which for a saved file
 * means a second full copy in the engine document's memory. This one is fed
 * a window of the file at a time and keeps 64 bytes between calls.
 * FIPS 180-4; checked against the browser's digest in the unit tests.
 */
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK_BYTES = 64;

export class Sha256 {
  private readonly state = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly words = new Int32Array(64);
  /** The bytes of an unfinished block, carried to the next update. */
  private readonly carry = new Uint8Array(BLOCK_BYTES);
  private carried = 0;
  private length = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error("sha256: update after digest");
    this.length += data.byteLength;
    let offset = 0;
    if (this.carried > 0) {
      const take = Math.min(BLOCK_BYTES - this.carried, data.byteLength);
      this.carry.set(data.subarray(0, take), this.carried);
      this.carried += take;
      offset = take;
      if (this.carried < BLOCK_BYTES) return this;
      this.compress(this.carry, 0);
      this.carried = 0;
    }
    for (; offset + BLOCK_BYTES <= data.byteLength; offset += BLOCK_BYTES) this.compress(data, offset);
    if (offset < data.byteLength) {
      this.carry.set(data.subarray(offset), 0);
      this.carried = data.byteLength - offset;
    }
    return this;
  }

  /** The 32-byte digest. The hash takes no more input afterwards. */
  digest(): Uint8Array {
    if (!this.finished) {
      this.finished = true;
      const bits = this.length * 8;
      // 0x80, zeros up to 56 bytes into a block, then the bit length as 64 bits, big-endian.
      const padding = new Uint8Array(((this.carried < 56 ? 56 : 120) - this.carried) + 8);
      padding[0] = 0x80;
      const view = new DataView(padding.buffer);
      view.setUint32(padding.length - 8, Math.floor(bits / 2 ** 32));
      view.setUint32(padding.length - 4, bits >>> 0);
      const tail = new Uint8Array(this.carried + padding.length);
      tail.set(this.carry.subarray(0, this.carried), 0);
      tail.set(padding, this.carried);
      for (let offset = 0; offset < tail.length; offset += BLOCK_BYTES) this.compress(tail, offset);
    }
    const out = new Uint8Array(32);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) view.setInt32(i * 4, this.state[i]!);
    return out;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const w = this.words;
    const s = this.state;
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      w[i] = (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = s[0]!, b = s[1]!, c = s[2]!, d = s[3]!, e = s[4]!, f = s[5]!, g = s[6]!, h = s[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    s[0] = (s[0]! + a) | 0; s[1] = (s[1]! + b) | 0; s[2] = (s[2]! + c) | 0; s[3] = (s[3]! + d) | 0;
    s[4] = (s[4]! + e) | 0; s[5] = (s[5]! + f) | 0; s[6] = (s[6]! + g) | 0; s[7] = (s[7]! + h) | 0;
  }
}
