import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { streamToNativeSink } from "../../../src/native/sink";
import type { NativeBridge } from "../../../src/native/bridge";
import type { HostResponse } from "../../../src/native/types";

function fakeBridge(): {
  bridge: NativeBridge;
  history: Array<{ type: string; [k: string]: unknown }>;
  fail: { open?: boolean; chunkAt?: number; close?: boolean };
} {
  const history: Array<{ type: string; [k: string]: unknown }> = [];
  const fail: { open?: boolean; chunkAt?: number; close?: boolean } = {};
  const bridge: NativeBridge = {
    isConnected: () => true,
    disconnect: () => undefined,
    requestStream: () => Promise.reject(new Error("not used")),
    async request(req: { type: string; [k: string]: unknown }) {
      history.push(req);
      if (req.type === "sink.open") {
        if (fail.open) {
          return { type: "error", nonce: "x", code: "native_sink_io_error", detail: "fail" } as unknown as HostResponse;
        }
        return { type: "sink.opened", nonce: "x", sinkId: "sink-1" } as HostResponse;
      }
      if (req.type === "sink.chunk") {
        const writes = history.filter(h => h.type === "sink.chunk").length;
        if (fail.chunkAt && writes >= fail.chunkAt) throw new Error("chunk write failed");
        const offset = req["offset"] as number;
        const data = atob(req["dataB64"] as string);
        return { type: "sink.ack", nonce: "x", sinkId: "sink-1", bytesAcked: offset + data.length } as HostResponse;
      }
      if (req.type === "sink.close") {
        if (fail.close) throw new Error("close failed");
        return { type: "complete", nonce: "x", outputPath: "/tmp/out.mp4", bytesWritten: 1024, checksum: "abc" } as HostResponse;
      }
      if (req.type === "sink.abort") {
        return { type: "sink.aborted", nonce: "x", sinkId: "sink-1", partialBytesDiscarded: 0 } as HostResponse;
      }
      throw new Error(`unexpected ${req.type}`);
    },
  };
  return { bridge, history, fail };
}

/** Minimal Blob fake — jsdom's Blob lacks arrayBuffer + stream. */
function fakeBlob(payload: Uint8Array): Blob {
  return {
    size: payload.byteLength,
    type: "application/octet-stream",
    async arrayBuffer() { return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength); },
    stream(): ReadableStream<Uint8Array> {
      let sent = false;
      return new ReadableStream({
        pull(controller) {
          if (sent) {
            controller.close();
            return;
          }
          sent = true;
          controller.enqueue(payload);
        },
      });
    },
    slice() { throw new Error("slice not implemented"); },
    text() { return Promise.resolve(""); },
    bytes() { return Promise.resolve(payload); },
  } as unknown as Blob;
}

let originalCryptoSubtle: SubtleCrypto;
beforeEach(() => {
  originalCryptoSubtle = globalThis.crypto.subtle;
  const fakeSubtle = {
    ...originalCryptoSubtle,
    async digest(_alg: string, _data: BufferSource) { return new Uint8Array(32).buffer; },
  };
  Object.defineProperty(globalThis.crypto, "subtle", { value: fakeSubtle, configurable: true });
});

afterEach(() => {
  Object.defineProperty(globalThis.crypto, "subtle", { value: originalCryptoSubtle, configurable: true });
});

describe("streamToNativeSink", () => {
  it("opens, chunks the blob in <=1 MB pieces, closes with sha256", async () => {
    const { bridge, history } = fakeBridge();
    const blob = fakeBlob(new Uint8Array(2 * 1024 * 1024 + 7));
    const onProgress = vi.fn();
    const r = await streamToNativeSink(bridge, "big.mp4", blob, new AbortController().signal, onProgress);

    expect(r.outputPath).toBe("/tmp/out.mp4");
    const opens = history.filter(h => h.type === "sink.open");
    const chunks = history.filter(h => h.type === "sink.chunk");
    const closes = history.filter(h => h.type === "sink.close");
    expect(opens).toHaveLength(1);
    expect(chunks.length).toBeGreaterThanOrEqual(3); // 1 MB + 1 MB + 7 B
    expect(closes).toHaveLength(1);
    expect(onProgress).toHaveBeenCalled();
  });

  it("aborts the sink + propagates AbortError when signal fires", async () => {
    const { bridge, history } = fakeBridge();
    const ac = new AbortController();
    const blob = fakeBlob(new Uint8Array(2 * 1024 * 1024));
    ac.abort();
    await expect(
      streamToNativeSink(bridge, "big.mp4", blob, ac.signal, vi.fn()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(history.find(h => h.type === "sink.chunk")).toBeUndefined();
  });

  it("aborts and rethrows when sink.close fails", async () => {
    const { bridge, fail } = fakeBridge();
    fail.close = true;
    const blob = fakeBlob(new Uint8Array(10));
    await expect(
      streamToNativeSink(bridge, "out.mp4", blob, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("close failed");
  });
});
