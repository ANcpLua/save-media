import { describe, expect, it, vi } from "vitest";
import { MAX_RECONNECTS, readThroughOutages, reconnectWaitMs } from "../../../src/engine/net/reconnect";
import { fetchWithRetry } from "../../../src/engine/net/fetch-with-retry";
import { BrowserFetchError, isOutage, isOutageAfterRetries, TransferError } from "../../../src/engine/net/transfer-error";
import { noWaits, waitsOf } from "../helpers/waits";

const URL = "https://cdn.example/seg2.ts";
const signal = () => new AbortController().signal;
const dropped = () => new TransferError("network", { url: URL, during: "request", retriesSpent: true }, false);

describe("reading through an outage", () => {
  it("waits 1, 2, 4, 8 and 16 seconds between reconnects, or as long as a busy server asks", () => {
    expect(Array.from({ length: MAX_RECONNECTS }, (_, index) => reconnectWaitMs(index))).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(reconnectWaitMs(0, 5000)).toBe(5000);
    expect(reconnectWaitMs(4, 5000)).toBe(16_000);
  });

  it("reads the same part again after each wait and returns it once the connection is back", async () => {
    const waits = noWaits();
    const heard: number[] = [];
    const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped())
      .mockResolvedValue("segment");
    expect(await readThroughOutages(read, signal(), waitMs => heard.push(waitMs))).toBe("segment");
    expect(read).toHaveBeenCalledTimes(4);
    expect(heard).toEqual([1000, 2000, 4000]);
    expect(waitsOf(waits)).toEqual([1000, 2000, 4000]);
  });

  it("gives up when the outage outlasts the reconnects, and says how many it made", async () => {
    const waits = noWaits();
    const read = vi.fn(async () => { throw dropped(); });
    await expect(readThroughOutages(read, signal(), () => undefined)).rejects.toMatchObject({ reason: "network", facts: { reconnects: MAX_RECONNECTS } });
    expect(read).toHaveBeenCalledTimes(MAX_RECONNECTS + 1);
    expect(waitsOf(waits)).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it("waits for nothing that a wait cannot change", async () => {
    const waits = noWaits();
    const failures: unknown[] = [
      new TransferError("http-status", { url: URL, status: 404 }),
      new TransferError("http-status", { url: URL, status: 403 }),
      // A certificate the browser refused stays refused.
      new TransferError("network", { url: URL, during: "request", diagnostic: { host: "cdn.example", code: "net::ERR_CERT_AUTHORITY_INVALID", ip: null, finalHost: null, redirect: null } }, false),
      new TransferError("body-long", { url: URL, received: 9, expected: 4 }),
      { code: "unexpected_media_response", severity: "terminal", response: "html" },
      new Error("a defect"),
    ];
    for (const failure of failures) {
      const read = vi.fn(async () => { throw failure; });
      await expect(readThroughOutages(read, signal(), () => undefined)).rejects.toBe(failure);
      expect(read).toHaveBeenCalledOnce();
    }
    expect(waits).not.toHaveBeenCalled();
  });

  it("honors a busy server's wait, and does not ask early when it asks for more than a save waits by itself", async () => {
    const waits = noWaits();
    const busy = (retryAfterMs: number) => new TransferError("http-status", { url: URL, status: 503, retryAfterMs, retriesSpent: true }, false);
    const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(busy(5000)).mockResolvedValue("segment");
    expect(await readThroughOutages(read, signal(), () => undefined)).toBe("segment");
    expect(waitsOf(waits)).toEqual([5000]);
    const long = busy(60_000);
    await expect(readThroughOutages(async () => { throw long; }, signal(), () => undefined)).rejects.toBe(long);
    expect(waitsOf(waits)).toEqual([5000]);
  });

  it("stops at once when the save is cancelled during a wait", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const read = vi.fn(async () => { throw dropped(); });
      const result = expect(readThroughOutages(read, controller.signal, () => undefined)).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(500);
      controller.abort(new DOMException("cancelled", "AbortError"));
      await result;
      expect(read).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe("what a request says after its own retries", () => {
  it("marks a failure that could still be retried, so a reconnect can follow it, and marks no other", async () => {
    noWaits();
    const after = (fetchFile: () => Promise<Response>) => fetchWithRetry(URL, signal(), "segment", {}, fetchFile).catch((error: unknown) => error);
    const noAnswer = await after(async () => { throw new TypeError("Failed to fetch"); });
    const busy = await after(async () => new Response("", { status: 503 }));
    for (const failure of [noAnswer, busy]) {
      expect(failure).toMatchObject({ retryable: false, facts: { retriesSpent: true } });
      // Not repeated at once by a caller that retries whole operations, and still an outage to come back to.
      expect(isOutage(failure)).toBe(false);
      expect(isOutageAfterRetries(failure)).toBe(true);
    }
    const missing = await after(async () => new Response("", { status: 404 }));
    const longWait = await after(async () => new Response("", { status: 503, headers: { "retry-after": "600" } }));
    const certificate = await after(async () => { throw new BrowserFetchError({ host: "cdn.example", code: "net::ERR_CERT_AUTHORITY_INVALID", ip: null, finalHost: null, redirect: null }); });
    for (const failure of [missing, longWait, certificate]) {
      expect((failure as TransferError).facts.retriesSpent).toBeUndefined();
      expect(isOutageAfterRetries(failure)).toBe(false);
    }
  });
});
