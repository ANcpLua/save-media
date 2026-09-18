// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDirectJob } from "../../../../src/engine/jobs/direct";

const fixture = new Uint8Array(readFileSync(new URL("../../../e2e/media-fixtures/direct/clip.mp4", import.meta.url)));
const plan = { kind: "direct" as const, url: "https://cdn.example/clip.mp4", filename: "clip.mp4" };

afterEach(() => vi.unstubAllGlobals());

describe("direct download recovery", () => {
  it("retries a truncated range and saves exactly the original bytes", async () => {
    let attempts = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const range = headers.get("range") ?? "";
      requests.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) return new Response("full requests fail", { status: 503 });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), fixture.length - 1);
      let bytes = fixture.slice(start, end + 1);
      if (headers.has("if-range")) {
        expect(headers.get("if-range")).toBe('"fixture-v1"');
        if (++attempts === 1) bytes = bytes.slice(0, Math.floor(bytes.length / 2));
      }
      return new Response(bytes, { status: 206, headers: {
        "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${fixture.length}`,
        etag: '"fixture-v1"',
      } });
    }));
    const onProgress = vi.fn();
    const result = await runDirectJob(plan, onProgress, new AbortController().signal);
    try {
      const saved = await (await fetchOriginal(result.blobUrl)).arrayBuffer();
      expect(new Uint8Array(saved)).toEqual(fixture);
      expect(attempts).toBe(2);
      expect(requests[0]).toBe("bytes=0-4095");
      expect(onProgress).toHaveBeenLastCalledWith(fixture.length, fixture.length, "finalizing");
    } finally {
      URL.revokeObjectURL(result.blobUrl);
    }
  });

  it("assembles concurrent ranges in file order when later chunks finish first", async () => {
    const data = new Uint8Array(fixture.length + 5 * 1024 * 1024);
    data.set(fixture);
    const view = new DataView(data.buffer);
    view.setUint32(fixture.length, data.length - fixture.length);
    data.set(new TextEncoder().encode("free"), fixture.length + 4);
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const completed: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const [start, end] = bounds(headers, data.length);
      if (headers.has("if-range")) {
        if (start === 0) await first;
        else releaseFirst();
        completed.push(start);
      }
      return rangedResponse(data, start, end);
    }));
    const result = await runDirectJob(plan, vi.fn(), new AbortController().signal);
    try {
      const saved = await (await fetchOriginal(result.blobUrl)).arrayBuffer();
      expect(saved.byteLength).toBe(data.length);
      expect(createHash("sha256").update(new Uint8Array(saved)).digest("hex"))
        .toBe(createHash("sha256").update(data).digest("hex"));
      expect(completed).toEqual([4 * 1024 * 1024, 0]);
    } finally { URL.revokeObjectURL(result.blobUrl); }
  });

  it("refuses an over-limit file before any chunk request", async () => {
    const fetchFn = vi.fn(async () => new Response(fixture.slice(0, 4096), { status: 206, headers: {
      "content-range": `bytes 0-4095/${2 * 1024 ** 3}`, etag: '"v1"',
    } }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(runDirectJob(plan, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "output_too_large_for_browser" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not create a saved result for structurally invalid media", async () => {
    const data = fixture.slice();
    new DataView(data.buffer).setUint32(0, data.length + 100);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const [start, end] = bounds(new Headers(init.headers), data.length);
      return rangedResponse(data, start, end);
    }));
    await expect(runDirectJob(plan, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "verification_container" });
  });

  it("aborts and joins sibling requests after a terminal range failure", async () => {
    let siblingsStopped = 0;
    let chunksStarted = 0;
    let allStarted!: () => void;
    const ready = new Promise<void>(resolve => { allStarted = resolve; });
    const total = 12 * 1024 * 1024;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (!headers.has("if-range")) return new Response(fixture.slice(0, 4096), { status: 206, headers: {
        "content-range": `bytes 0-4095/${total}`, etag: '"v1"',
      } });
      if (++chunksStarted === 3) allStarted();
      if (headers.get("range")!.startsWith("bytes=0-")) {
        await ready;
        return new Response("forbidden", { status: 403 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          siblingsStopped++;
          reject(init.signal!.reason);
        }, { once: true });
      });
    }));
    await expect(runDirectJob(plan, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: "access_denied", httpStatus: 403 });
    expect(siblingsStopped).toBe(2);
  });
});

const fetchOriginal = globalThis.fetch;

function bounds(headers: Headers, size: number): [number, number] {
  const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
  if (!match) throw new Error("range required");
  return [Number(match[1]), Math.min(Number(match[2]), size - 1)];
}

function rangedResponse(data: Uint8Array, start: number, end: number): Response {
  return new Response(data.slice(start, end + 1), { status: 206, headers: {
    "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${data.length}`, etag: '"fixture-v1"',
  } });
}
