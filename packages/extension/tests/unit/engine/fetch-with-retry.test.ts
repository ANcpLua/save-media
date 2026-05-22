import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry } from "../../../src/engine/net/fetch-with-retry";

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
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return new Response("", { status: n < 2 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const resp = await fetchWithRetry("https://x/", new AbortController().signal, "segment");
    expect(resp.status).toBe(200);
    expect(n).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("fast-fails on a non-retryable status (404)", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(fetchWithRetry("https://x/", new AbortController().signal, "segment"))
      .rejects.toMatchObject({ url: "https://x/", status: 404 });
    expect(n).toBe(1);
  });

  it("propagates AbortError when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    globalThis.fetch = vi.fn(async () => { throw new DOMException("u", "AbortError"); }) as unknown as typeof fetch;
    await expect(fetchWithRetry("https://x/", ac.signal, "segment")).rejects.toMatchObject({ name: "AbortError" });
  });
});
