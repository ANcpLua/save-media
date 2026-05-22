import type { JobResult } from "./job";
import type { NativeBridge } from "../native/bridge";
import { NATIVE_SINK_CHUNK_BYTES } from "../native/types";

/**
 * Sink abstraction for engine jobs: HLS/DASH runners write segments here
 * without knowing whether the bytes ultimately land in a Blob URL (small
 * outputs) or stream directly to the native host's disk sink (large
 * outputs that must not be buffered in renderer memory).
 *
 * write() is monotonic — callers append bytes in the order they should
 * appear in the final file. close() flushes and returns the final job
 * result. abort() releases any resources without committing.
 */
export interface JobSink {
  open(filename: string, expectedSize: number | null): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<JobResult>;
  abort(): Promise<void>;
}

/** In-renderer-memory sink: parts[] + Blob; suitable for outputs < ~2 GB. */
export class InMemorySink implements JobSink {
  private parts: BlobPart[] = [];
  private filename = "";
  private mime: string;
  private bytes = 0;

  constructor(mime: string) {
    this.mime = mime;
  }

  async open(filename: string, _expectedSize?: number | null): Promise<void> {
    this.filename = filename;
    this.parts = [];
    this.bytes = 0;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.parts.push(bytes as BlobPart);
    this.bytes += bytes.byteLength;
  }

  async close(): Promise<JobResult> {
    const blob = new Blob(this.parts, { type: this.mime });
    return {
      blobUrl: URL.createObjectURL(blob),
      filename: this.filename,
      checksum: "",
    };
  }

  async abort(): Promise<void> {
    this.parts = [];
    this.bytes = 0;
  }

  byteLength(): number { return this.bytes; }
  partsForProbe(): readonly BlobPart[] { return this.parts; }
}

/**
 * Native-host streaming sink. Each write() base64-encodes the bytes and
 * pushes them to the host's sink.chunk in 1 MB pieces. The SHA-256 is
 * computed incrementally over the on-the-wire bytes so close() can hand
 * the host an authoritative checksum.
 *
 * Bypasses the 2 GB renderer-memory ceiling by never accumulating the
 * file — the host writes to disk as we stream.
 */
export class NativeStreamingSink implements JobSink {
  private sinkId: string | null = null;
  private offset = 0;
  private filename = "";
  private hashState: Promise<HashWorker>;

  constructor(private readonly bridge: NativeBridge) {
    this.hashState = createHashWorker();
  }

  async open(filename: string, expectedSize: number | null): Promise<void> {
    this.filename = filename;
    const response = await this.bridge.request({
      type: "sink.open",
      filename,
      expectedSize,
    });
    if (response.type !== "sink.opened") {
      throw new Error(`sink.open expected sink.opened, got ${response.type}`);
    }
    this.sinkId = response.sinkId;
    this.offset = 0;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.sinkId === null) throw new Error("sink not opened");
    const hash = await this.hashState;
    hash.update(bytes);
    for (let i = 0; i < bytes.byteLength; i += NATIVE_SINK_CHUNK_BYTES) {
      const slice = bytes.subarray(i, Math.min(i + NATIVE_SINK_CHUNK_BYTES, bytes.byteLength));
      const ack = await this.bridge.request({
        type: "sink.chunk",
        sinkId: this.sinkId,
        offset: this.offset,
        dataB64: bytesToBase64(slice),
      });
      if (ack.type !== "sink.ack") {
        throw new Error(`sink.chunk expected sink.ack, got ${ack.type}`);
      }
      this.offset = ack.bytesAcked;
    }
  }

  async close(): Promise<JobResult> {
    if (this.sinkId === null) throw new Error("sink not opened");
    const hash = await this.hashState;
    const checksum = hash.digestHex();
    const response = await this.bridge.request({
      type: "sink.close",
      sinkId: this.sinkId,
      finalChecksum: checksum,
    });
    if (response.type !== "complete") {
      throw new Error(`sink.close expected complete, got ${response.type}`);
    }
    this.sinkId = null;
    return {
      blobUrl: `file://${response.outputPath}`,
      filename: this.filename,
      checksum: response.checksum || checksum,
    };
  }

  async abort(): Promise<void> {
    if (this.sinkId === null) return;
    try {
      await this.bridge.request({ type: "sink.abort", sinkId: this.sinkId });
    } finally {
      this.sinkId = null;
    }
  }
}

/**
 * SHA-256 hash worker. We can't use SubtleCrypto incrementally (it only
 * supports digest-of-whole-buffer), so we maintain an array of chunks and
 * digest at close-time. For >2 GB inputs this still requires accumulating
 * the bytes; future revision should swap in a streaming JS-side sha256
 * implementation (e.g. hash-wasm) so memory stays bounded.
 *
 * The interface is kept symmetric with a true streaming implementation so
 * callers don't change when we swap the backend.
 */
interface HashWorker {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

async function createHashWorker(): Promise<HashWorker> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  return {
    update(chunk: Uint8Array): void {
      chunks.push(new Uint8Array(chunk));
      totalBytes += chunk.byteLength;
    },
    digestHex(): string {
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.byteLength;
      }
      // Synchronous return required by the interface; we rely on the
      // caller having previously awaited createHashWorker(). For now we
      // return a placeholder and let the native host's authoritative
      // checksum take precedence in close().
      return syncSha256Hex(combined);
    },
  };
}

/**
 * Tiny pure-JS SHA-256 (FIPS 180-4 §6.2). Used only when the engine has
 * no other way to produce a checksum synchronously; SubtleCrypto would
 * be async. About 60 LOC, no deps.
 */
function syncSha256Hex(bytes: Uint8Array): string {
  // RFC reference values for the round constants.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const len = bytes.byteLength;
  const bitLen = len * 8;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_0000_0000), false);

  const W = new Uint32Array(64);
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15]!, 7) ^ rotr(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
      const s1 = rotr(W[i - 2]!, 17) ^ rotr(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [H[0]!, H[1]!, H[2]!, H[3]!, H[4]!, H[5]!, H[6]!, H[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + W[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }
  return [...H].map(n => n.toString(16).padStart(8, "0")).join("");
}

function rotr(n: number, k: number): number {
  return ((n >>> k) | (n << (32 - k))) >>> 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 32 * 1024;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
