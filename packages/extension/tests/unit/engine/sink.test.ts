import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemorySink, NativeStreamingSink } from "../../../src/engine/sink";
import type { NativeBridge } from "../../../src/native/bridge";
import type { HostResponse } from "../../../src/native/types";

let originalCreateObjectURL: typeof URL.createObjectURL;
beforeEach(() => {
  originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:fake");
});
afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
});

describe("InMemorySink", () => {
  it("accumulates writes and closes into a Blob URL", async () => {
    const sink = new InMemorySink("video/mp4");
    await sink.open("out.mp4", null);
    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.write(new Uint8Array([4, 5]));
    const result = await sink.close();
    expect(result.filename).toBe("out.mp4");
    expect(result.blobUrl).toBe("blob:fake");
    expect(sink.byteLength()).toBe(5);
  });

  it("abort drops accumulated parts so a later open starts clean", async () => {
    const sink = new InMemorySink("video/mp4");
    await sink.open("out.mp4", null);
    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.abort();
    expect(sink.byteLength()).toBe(0);
  });
});

function fakeBridge(): {
  bridge: NativeBridge;
  history: Array<{ type: string; [k: string]: unknown }>;
  fail: { open?: boolean; close?: boolean };
} {
  const history: Array<{ type: string; [k: string]: unknown }> = [];
  const fail: { open?: boolean; close?: boolean } = {};
  const bridge: NativeBridge = {
    isConnected: () => true,
    disconnect: () => undefined,
    requestStream: () => Promise.reject(new Error("not used")),
    async request(req: { type: string; [k: string]: unknown }) {
      history.push(req);
      if (req.type === "sink.open") {
        if (fail.open) throw new Error("open failed");
        return { type: "sink.opened", nonce: "x", sinkId: "sink-1" } as HostResponse;
      }
      if (req.type === "sink.chunk") {
        const offset = req["offset"] as number;
        const data = atob(req["dataB64"] as string);
        return { type: "sink.ack", nonce: "x", sinkId: "sink-1", bytesAcked: offset + data.length } as HostResponse;
      }
      if (req.type === "sink.close") {
        if (fail.close) throw new Error("close failed");
        return {
          type: "complete",
          nonce: "x",
          outputPath: "/Users/x/Downloads/save-media/big.mp4",
          bytesWritten: (req["finalChecksum"] as string).length, // dummy
          checksum: req["finalChecksum"] as string,
        } as HostResponse;
      }
      if (req.type === "sink.abort") {
        return { type: "sink.aborted", nonce: "x", sinkId: "sink-1", partialBytesDiscarded: 0 } as HostResponse;
      }
      throw new Error(`unexpected ${req.type}`);
    },
  };
  return { bridge, history, fail };
}

describe("NativeStreamingSink — bytes go to the wire without renderer accumulation", () => {
  it("streams a 2.5 MB write as three sink.chunks of ≤1 MB each", async () => {
    const { bridge, history } = fakeBridge();
    const sink = new NativeStreamingSink(bridge);
    await sink.open("big.mp4", 2_500_000);
    await sink.write(new Uint8Array(2_500_000));
    const result = await sink.close();
    const chunks = history.filter(h => h.type === "sink.chunk");
    // 1 MB + 1 MB + ~500 KB = at least 3 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      const data = atob(c["dataB64"] as string);
      expect(data.length).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(result.blobUrl.startsWith("file://")).toBe(true);
    expect(result.filename).toBe("big.mp4");
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computes the same SHA-256 a reference implementation would", async () => {
    const { bridge } = fakeBridge();
    const sink = new NativeStreamingSink(bridge);
    await sink.open("clip.mp4", null);
    const payload = new Uint8Array([0x68, 0x69]); // "hi"
    await sink.write(payload);
    const result = await sink.close();
    // sha256("hi") = 8f434346...30498a78
    expect(result.checksum).toBe("8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4");
  });

  it("write after close throws", async () => {
    const { bridge } = fakeBridge();
    const sink = new NativeStreamingSink(bridge);
    await sink.open("x", null);
    await sink.close();
    await expect(sink.write(new Uint8Array([1]))).rejects.toThrow("not opened");
  });

  it("abort sends sink.abort and is idempotent", async () => {
    const { bridge, history } = fakeBridge();
    const sink = new NativeStreamingSink(bridge);
    await sink.open("x", null);
    await sink.abort();
    await sink.abort(); // second call must not throw
    expect(history.filter(h => h.type === "sink.abort")).toHaveLength(1);
  });
});
