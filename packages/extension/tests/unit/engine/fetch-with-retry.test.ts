import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry } from "../../../src/engine/net/fetch-with-retry";
import { computeBackoffMs } from "@savemedia/core";
import { noWaits, waitsOf } from "../helpers/waits";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchWithRetry", () => {
  it("returns the response on first success", async () => {
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const resp = await fetchWithRetry("https://x/", new AbortController().signal, "segment");
    expect(resp.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable statuses then succeeds", async () => {
    const waits = noWaits();
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return new Response("", { status: n < 2 ? 522 : 200 });
    }) as unknown as typeof fetch;
    const resp = await fetchWithRetry("https://x/", new AbortController().signal, "segment");
    expect(resp.status).toBe(200);
    expect(n).toBe(2);
    // One wait before the one retry: the policy's first backoff for a segment, with its jitter.
    expect(waitsOf(waits)).toEqual([expect.any(Number)]);
    expect(waitsOf(waits)[0]).toBeGreaterThanOrEqual(computeBackoffMs("segment", 0, 0));
    expect(waitsOf(waits)[0]).toBeLessThanOrEqual(computeBackoffMs("segment", 0, 1));
  });

  it("honors Retry-After and ends retries when the server asks for a longer wait", async () => {
    vi.useFakeTimers();
    try {
      const fetchFile = vi.fn().mockResolvedValueOnce(new Response("", { status: 522, headers: { "Retry-After": "2" } }))
        .mockResolvedValueOnce(new Response("", { status: 522, headers: { "Retry-After": "60" } }));
      const result = fetchWithRetry("https://example.test", new AbortController().signal, "manifest", {}, fetchFile);
      const rejected = expect(result).rejects.toMatchObject({ reason: "http-status", retryable: false, facts: { status: 522, retryAfterMs: 60_000 } });
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchFile).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(fetchFile).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("fast-fails on a non-retryable status (404)", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(fetchWithRetry("https://x/", new AbortController().signal, "segment"))
      .rejects.toMatchObject({ reason: "http-status", facts: { url: "https://x/", status: 404 } });
    expect(n).toBe(1);
  });

  it("reports a request that never got an answer as a network failure, without engine prose", async () => {
    vi.useFakeTimers();
    try {
      const fetchFile = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
      const result = fetchWithRetry("https://x/", new AbortController().signal, "segment", {}, fetchFile);
      const rejected = expect(result).rejects.toMatchObject({ reason: "network", retryable: false, facts: { url: "https://x/", during: "request" } });
      await vi.runAllTimersAsync();
      await rejected;
      expect(fetchFile.mock.calls.length).toBeGreaterThan(1);
    } finally { vi.useRealTimers(); }
  });

  it("propagates AbortError when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    globalThis.fetch = vi.fn(async () => { throw new DOMException("u", "AbortError"); }) as unknown as typeof fetch;
    await expect(fetchWithRetry("https://x/", ac.signal, "segment")).rejects.toMatchObject({ name: "AbortError" });
  });
});
