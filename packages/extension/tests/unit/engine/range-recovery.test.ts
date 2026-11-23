// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMediaRange, probeMedia, rangeFailure, rangeMetadata, recoverRequest } from "../../../src/engine/net/range-recovery";
import { isOutage, retainedOutcome, TransferError, type TransferFacts, type TransferReason } from "../../../src/engine/net/transfer-error";
import { noWaits, waitsOf } from "../helpers/waits";

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

  it.each([401, 402, 403, 404])("does not retry HTTP %s and cancels its body", async status => {
    const cancelled = vi.fn();
    const fetchFn = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { status }));
    await expect(probeMedia(fetchFn, url)).rejects.toMatchObject({ reason: "http-status", retryable: false, facts: { status } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("tries one whole request when ranges are rejected, then stops on a second 416", async () => {
    const cancelled = vi.fn();
    const fetchFn = vi.fn(async (_url: string, _init: { headers?: Readonly<Record<string, string>> }) =>
      new Response(new ReadableStream({ cancel: cancelled }), { status: 416 }));
    await expect(probeMedia(fetchFn, url)).rejects.toMatchObject({ reason: "http-status", facts: { status: 416 } });
    expect(fetchFn.mock.calls.map(call => call[1].headers?.range)).toEqual(["bytes=0-4095", undefined]);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("exhausts three transient probe attempts without accepting an error page", async () => {
    const waits = noWaits();
    const fetchFn = vi.fn(async () => new Response("temporarily unavailable", { status: 503 }));
    await expect(probeMedia(fetchFn, url)).rejects.toMatchObject({ reason: "http-status", retryable: true, facts: { status: 503 } });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // A longer wait before each further attempt, and none after the last.
    expect(waitsOf(waits)).toEqual([1000, 2000]);
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
    await expect(fetchMediaRange(url, 0, 9, metadata, { signal: signal() })).rejects.toMatchObject({ retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized range bodies without consuming the entire stream", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(11)); }, cancel: cancelled,
    }), { status: 206, headers: { "content-range": "bytes 0-9/100", etag: '"v1"' } })));
    await expect(fetchMediaRange(url, 0, 9, metadata, { signal: signal() })).rejects.toMatchObject({ reason: "body-long", retryable: false });
    expect(cancelled).toHaveBeenCalled();
  });

  it("retries an empty 206 at the same offset with a short range and then restores its normal request size", async () => {
    const waits = noWaits();
    const start = 3200;
    const total = start + 3 * 65536;
    const source = Uint8Array.from({length: total}, (_, i) => i % 251);
    const requested: string[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("if-range")).toBe(metadata.validator);
      const range = headers.get("range")!;
      requested.push(range);
      const [, lo, hi] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const bytes = requested.length === 1 ? new Uint8Array() : source.slice(Number(lo), Number(hi) + 1);
      return new Response(bytes, {status: 206, headers: {"content-range": `bytes ${lo}-${hi}/${total}`, etag: metadata.validator}});
    };
    const bytes = await fetchMediaRange(url, start, total - 1, {...metadata, total}, { signal: signal(), fetchFile });
    expect(requested).toEqual([`bytes=${start}-${total - 1}`, `bytes=${start}-${start + 65536 - 1}`, `bytes=${start + 65536}-${total - 1}`]);
    expect(bytes).toEqual(source.slice(start));
    // One wait, before the one retry.
    expect(waits).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("fills a capped range from checked offsets (contradictory first length=%s)", async contradictory => {
    const requests: string[] = [];
    const fetchFile = vi.fn(async (_url: string, init: RequestInit) => {
      const range = new Headers(init.headers).get("range")!;
      requests.push(range);
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(a), end = Math.min(Number(b), start + 3);
      const wrong = contradictory && requests.length === 1;
      const bytes = Uint8Array.from({length: end - start + 1}, (_, index) => wrong ? 255 : start + index);
      return new Response(bytes, {status: 206, headers: {
        "content-range": `bytes ${start}-${wrong ? b : end}/100`, etag: '"v1"',
        "content-length": `${bytes.length}, ${bytes.length}`,
      }});
    });
    const bytes = await fetchMediaRange(url, 10, 19, metadata, { signal: signal(), fetchFile });
    expect(bytes).toEqual(Uint8Array.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]));
    expect(requests).toEqual(["bytes=10-19", ...(contradictory ? ["bytes=10-13"] : []), "bytes=14-17", "bytes=18-19"]);
  });

  it("reopens a contradictory probe and reads only the prefix of the complete response", async () => {
    const requests: (string | null)[] = [];
    const fetchFile = async (_url: string, init: RequestInit) => {
      const range = new Headers(init.headers).get("range");
      requests.push(range);
      if (range) return new Response(Uint8Array.of(255), {status: 206, headers: {
        "content-range": "bytes 0-4095/9000", "content-length": "9000", etag: '"v1"',
      }});
      return new Response(new Uint8Array(9000).fill(42), {headers: {"content-length": "9000", etag: '"v1"'}});
    };
    const result = await probeMedia(fetchFile, url);
    expect(result.bytes).toEqual(new Uint8Array(4096).fill(42));
    expect(requests).toEqual(["bytes=0-4095", null]);
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

  it("reads an HTTP 200 to a range in place when the caller accepts the whole file, and otherwise names it", async () => {
    const fetchFile = async () => new Response(new Uint8Array(100).fill(5), { headers: { etag: '"v1"' } });
    const whole = await fetchMediaRange(url, 10, 19, metadata, { signal: signal(), fetchFile,
      onWholeResponse: async response => new Uint8Array(await response.arrayBuffer()).length });
    expect(whole).toEqual({ whole: 100 });
    await expect(fetchMediaRange(url, 10, 19, metadata, { signal: signal(), fetchFile }))
      .rejects.toMatchObject({ reason: "range-ignored", facts: { status: 200 } });
  });

  it("maps every transfer reason to one JobError without engine prose", () => {
    const at = (error: TransferError) => rangeFailure(error, url, "direct");
    expect(at(new TransferError("http-status", { url, status: 403 }))).toMatchObject({ code: "access_denied", httpStatus: 403 });
    expect(at(new TransferError("network", { url, during: "body", received: 10, expected: 100 })))
      .toEqual({ code: "network_unreachable", severity: "terminal", phase: "direct", url: "https://cdn.example", during: "transfer",
        receivedBytes: 10, totalBytes: 100 });
    expect(at(new TransferError("timeout", { url }))).toMatchObject({ code: "network_unreachable", during: "timeout" });
    expect(at(new TransferError("range-refused", { url, status: 416, received: 10, expected: 100 })))
      .toEqual({ code: "transfer_failed", severity: "terminal", reason: "resume-refused", host: "cdn.example",
        receivedBytes: 10, totalBytes: 100, httpStatus: 416 });
    expect(at(new TransferError("no-validator", { url, received: 10, expected: 100 }))).toMatchObject({ reason: "resume-unverifiable" });
    expect(at(new TransferError("content-mismatch", { url }))).toMatchObject({ reason: "content-mismatch" });
    expect(at(new TransferError("insecure-redirect", { url }))).toEqual({ code: "insecure_media_redirect", severity: "terminal" });
    expect(rangeFailure(new RangeError("internal"), url, "direct"))
      .toEqual({ code: "engine_job_failed", severity: "terminal", at: "direct", cause: "unexpected", detail: "RangeError" });
  });

  it.each([400, 416, 501])("names HTTP %i to a range request range-refused, wherever the range is asked for", async status => {
    const fetchFile = async () => new Response(null, { status, headers: { "content-range": "bytes */100" } });
    await expect(fetchMediaRange(url, 10, 19, metadata, { signal: signal(), fetchFile }))
      .rejects.toMatchObject({ reason: "range-refused", retryable: false, facts: { status, received: 10, expected: metadata.total } });
  });

  it("decides retries, reconnects and retained bytes from one table", () => {
    const failure = (reason: TransferReason, facts: Partial<TransferFacts> = {}, retryable?: boolean) =>
      new TransferError(reason, { url, ...facts }, retryable);
    expect([failure("network"), failure("timeout"), failure("http-status", { status: 503 }, true)].map(isOutage)).toEqual([true, true, true]);
    expect([failure("http-status", { status: 404 }), failure("body-short"), failure("range-empty")].map(isOutage)).toEqual([false, false, false]);
    expect(Object.fromEntries((["network", "body-short", "range-empty", "range-refused", "no-validator", "range-ignored", "changed",
      "content-mismatch", "checksum"] as const).map(reason => [reason, retainedOutcome(failure(reason))]))).toEqual({
      network: "keep", "body-short": "keep", "range-empty": "keep", "range-refused": "drop", "no-validator": "drop",
      "range-ignored": "drop", changed: "restart", "content-mismatch": "restart", checksum: "restart",
    });
    expect(retainedOutcome(failure("http-status", { status: 503 }, true))).toBe("keep");
    expect(retainedOutcome(failure("http-status", { status: 403 }))).toBe("drop");
    expect(retainedOutcome({ code: "unexpected_media_response", severity: "terminal", response: "page" })).toBe("drop");
  });

  it("aborts stalled attempts and stops at the probe retry budget", async () => {
    vi.useFakeTimers();
    const attemptSignals: AbortSignal[] = [];
    const pending = recoverRequest(attemptSignal => new Promise((_resolve, reject) => {
      attemptSignals.push(attemptSignal);
      attemptSignal.addEventListener("abort", () => reject(attemptSignal.reason), { once: true });
    }), signal());
    const assertion = expect(pending).rejects.toMatchObject({ reason: "timeout" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(attemptSignals).toHaveLength(3);
    expect(attemptSignals.every(s => s.aborted)).toBe(true);
  });
});
