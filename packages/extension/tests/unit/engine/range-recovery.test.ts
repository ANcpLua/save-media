// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMediaRange, probeMedia, rangeMetadata, recoverRequest } from "../../../src/engine/net/range-recovery";

const url = "https://cdn.example/clip.mp4";
const metadata = { total: 100, validator: '"v1"', validatorHeader: "etag" as const };
const signal = () => new AbortController().signal;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("range recovery transport", () => {
  it("bounds a 200 probe to 4 KiB when the server ignores Range", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const result = await probeMedia(async () => new Response(body, { headers: { "content-range": "bytes 0-4095/9000" } }), url);
    expect(result.bytes.length).toBe(4096);
    expect(result.headers["content-range"]).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(7);
  });

  it.each([401, 402, 403, 404, 416])("does not retry HTTP %s and cancels its body", async status => {
    const cancelled = vi.fn();
    const fetchFn = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { status }));
    await expect(probeMedia(fetchFn, url)).rejects.toMatchObject({ status });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("exhausts three transient probe attempts without accepting an error page", async () => {
    const fetchFn = vi.fn(async () => new Response("temporarily unavailable", { status: 503 }));
    await expect(probeMedia(fetchFn, url)).rejects.toMatchObject({ status: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each([
    [200, { "content-range": "bytes 0-9/100", etag: '"v1"' }],
    [206, { "content-range": "bytes 1-10/100", etag: '"v1"' }],
    [206, { "content-range": "bytes 0-9/101", etag: '"v1"' }],
    [206, { "content-range": "bytes 0-9/100", etag: '"v2"' }],
    [206, { "content-range": "bytes 0-9/100", "content-encoding": "gzip" }],
  ] as const)("rejects ignored ranges, changed files and encoded ranges", async (status, headers) => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(10), { status, headers: { ...headers } }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(fetchMediaRange(url, 0, 9, metadata, signal())).rejects.toMatchObject({ retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized range bodies without consuming the entire stream", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(11)); }, cancel: cancelled,
    }), { status: 206, headers: { "content-range": "bytes 0-9/100", etag: '"v1"' } })));
    await expect(fetchMediaRange(url, 0, 9, metadata, signal())).rejects.toThrow("exceeds requested length");
    expect(cancelled).toHaveBeenCalled();
  });

  it("accepts Last-Modified when an ETag is weak, but never a weak ETag alone", () => {
    const headers = { "content-range": "bytes 0-99/100", etag: 'W/"v1"' };
    expect(rangeMetadata(headers)).toBeNull();
    expect(rangeMetadata({ ...headers, "last-modified": "Fri, 18 Sep 2026 12:00:00 GMT" }))
      .toMatchObject({ validatorHeader: "last-modified" });
  });

  it("cancels before retrying without starting another request", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      queueMicrotask(() => controller.abort());
      return new Response("busy", { status: 503 });
    });
    await expect(probeMedia(fetchFn, url, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("aborts stalled attempts and stops at the probe retry budget", async () => {
    vi.useFakeTimers();
    const attemptSignals: AbortSignal[] = [];
    const pending = recoverRequest(attemptSignal => new Promise((_resolve, reject) => {
      attemptSignals.push(attemptSignal);
      attemptSignal.addEventListener("abort", () => reject(attemptSignal.reason), { once: true });
    }), signal());
    const assertion = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(attemptSignals).toHaveLength(3);
    expect(attemptSignals.every(s => s.aborted)).toBe(true);
  });
});
