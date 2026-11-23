// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readSegment, type Request } from "../../../src/engine/hls-segments";
import { MAX_RECONNECTS } from "../../../src/engine/net/reconnect";
import { TransferError } from "../../../src/engine/net/transfer-error";
import { noWaits, waitsOf } from "../helpers/waits";

const url = "https://cdn.example/seg1.ts";
const signal = () => new AbortController().signal;

/** A response whose body arrives in the given chunks. */
function inChunks(chunks: readonly Uint8Array[], headers: Record<string, string> = {}, onChunk: (index: number) => void = () => undefined): Request {
  return vi.fn(async () => {
    let at = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at === chunks.length) { controller.close(); return; }
        onChunk(at);
        controller.enqueue(chunks[at++]!);
      },
    }), { headers });
  }) as unknown as Request;
}

const chunks = [new Uint8Array(1000).fill(1), new Uint8Array(3000).fill(2), new Uint8Array(500).fill(3)];
const joined = Uint8Array.from(chunks.flatMap(chunk => [...chunk]));

describe("one segment's bytes", () => {
  it("fills one buffer of the stated length as the chunks arrive, so a long segment is in memory once", async () => {
    // Counts the buffers of the segment's length that are made while it is read.
    const real = globalThis.Uint8Array;
    let buffers = 0;
    vi.stubGlobal("Uint8Array", new Proxy(real, {
      construct(target, args: unknown[]) {
        if (args[0] === 4500) buffers++;
        return Reflect.construct(target, args) as object;
      },
    }));
    let bytes: Uint8Array;
    let madeBeforeLastChunk = 0;
    try {
      bytes = await readSegment(url, signal(), inChunks(chunks, { "content-length": "4500" },
        index => { if (index === chunks.length - 1) madeBeforeLastChunk = buffers; }));
    } finally { vi.unstubAllGlobals(); }
    // The buffer is there before the body has arrived: the chunks go into it, they are not collected first.
    expect(madeBeforeLastChunk).toBe(1);
    expect(bytes).toEqual(joined);
    // The buffer is the segment: nothing was joined into a second one.
    expect(buffers).toBe(1);
    expect(bytes.buffer.byteLength).toBe(4500);
  });

  it("joins the chunks when the server states no length, or states the length of a coded body", async () => {
    expect(await readSegment(url, signal(), inChunks(chunks))).toEqual(joined);
    expect(await readSegment(url, signal(), inChunks(chunks, { "content-length": "99", "content-encoding": "gzip" }))).toEqual(joined);
    expect(await readSegment(url, signal(), inChunks([chunks[0]!]))).toEqual(chunks[0]);
  });

  it("still refuses a body that is longer or shorter than the server stated", async () => {
    await expect(readSegment(url, signal(), inChunks(chunks, { "content-length": "4000" }))).rejects.toMatchObject({ reason: "body-long" });
    await expect(readSegment(url, signal(), inChunks(chunks, { "content-length": "5000" }))).rejects.toMatchObject({ reason: "body-short" });
  }, 20_000);

  // A server that accepts the connection and then sends nothing. Each stall lasts as long as a request waits
  // for a byte (45 s), so the number of requests is the time the save is held.
  it("reads a segment that stalls once per reconnect, never three times before each: a hanging server costs six stalls, not eighteen", async () => {
    const waits = noWaits();
    const heard: number[] = [];
    const stalls = vi.fn(async () => { throw new TransferError("timeout", { url, during: "body" }); }) as unknown as Request;
    await expect(readSegment(url, signal(), stalls, waitMs => heard.push(waitMs)))
      .rejects.toMatchObject({ reason: "timeout", facts: { reconnects: MAX_RECONNECTS } });
    expect(stalls).toHaveBeenCalledTimes(MAX_RECONNECTS + 1);
    expect(heard).toEqual([1000, 2000, 4000, 8000, 16_000]);
    // No quick retry was made between the reconnects.
    expect(waitsOf(waits)).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it("takes a stall the attempt's own timer ends the same way, and goes on once the server answers", async () => {
    const waits = noWaits();
    let calls = 0;
    // The first request never answers; the attempt's stall timer ends it, as the engine's fetch reports that.
    const request = vi.fn(async (_url: string, attemptSignal: AbortSignal) => {
      if (calls++ > 0) return new Response(chunks[0] as BodyInit);
      return new Promise<Response>((_resolve, reject) => attemptSignal.addEventListener("abort", () => reject(attemptSignal.reason), { once: true }));
    }) as unknown as Request;
    vi.useFakeTimers();
    try {
      const read = readSegment(url, signal(), request);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await read).toEqual(chunks[0]);
    } finally { vi.useRealTimers(); }
    expect(request).toHaveBeenCalledTimes(2);
    // One reconnect wait, and no quick retry before it.
    expect(waitsOf(waits)).toEqual([1000]);
  });

  it("still reads a body that drops after its headers again at once, without a reconnect wait", async () => {
    const waits = noWaits();
    let calls = 0;
    const request = vi.fn(async () => {
      if (calls++ > 0) return new Response(chunks[0] as BodyInit);
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new TypeError("network error")); } }));
    }) as unknown as Request;
    expect(await readSegment(url, signal(), request)).toEqual(chunks[0]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(waitsOf(waits).some(ms => ms >= 1000)).toBe(false);
  });
});
