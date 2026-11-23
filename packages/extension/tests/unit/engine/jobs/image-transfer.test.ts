// @vitest-environment node
//
// How an image request ends when the network does not deliver it: in the engine document's own terms
// (the browser's fetch, its abort reasons and its streams), which the node environment shares.
import { describe, expect, it, vi } from "vitest";
import { runImageJob } from "../../../../src/engine/jobs/image";
import { BlobParts, FOLD_BYTES } from "../../../../src/engine/blob-parts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const signal = () => new AbortController().signal;
const respond = (body: BodyInit, init: ResponseInit = {}) => vi.fn(async () => new Response(body, init));

describe("the image job's transfer", () => {
  // A response whose body is fed by hand and ends with an error when its request is aborted, as the browser's does.
  function fedBy(feed: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
    return vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
        feed(controller);
      },
    }), { headers: { "content-type": "image/png" } }));
  }

  it("ends as a stalled transfer when the server sends the first bytes and then nothing", async () => {
    vi.useFakeTimers();
    try {
      const outcome = runImageJob("https://cdn.example/stalls.png", signal(), fedBy(controller => controller.enqueue(PNG)))
        .then(result => ({ result }), (error: unknown) => ({ error }));
      await vi.advanceTimersByTimeAsync(44_000);
      let settled = false;
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await outcome).toEqual({ error: expect.objectContaining({ code: "network_unreachable", during: "timeout", phase: "direct",
        url: "https://cdn.example", receivedBytes: PNG.byteLength }) });
    } finally { vi.useRealTimers(); }
  });

  it("ends as a stalled request when the server never answers", async () => {
    vi.useFakeTimers();
    try {
      const never = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }));
      const outcome = runImageJob("https://cdn.example/silent.png", signal(), never).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(46_000);
      expect(await outcome).toMatchObject({ code: "network_unreachable", during: "timeout" });
      expect(never).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("ends at once when the save is given up, and says so with the abort itself", async () => {
    const controller = new AbortController();
    const pending = runImageJob("https://cdn.example/slow.png", controller.signal, fedBy(feed => feed.enqueue(PNG)));
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort(new DOMException("given up", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a request the browser could not make as a network failure, not as a fault of savemedia", async () => {
    const unreachable = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(runImageJob("https://cdn.example/pic.jpg", signal(), unreachable))
      .rejects.toMatchObject({ code: "network_unreachable", during: "request", url: "https://cdn.example" });
    expect(unreachable).toHaveBeenCalledTimes(1);
  });

  it("reports a body that drops part-way as a lost connection", async () => {
    const dropped = fedBy(controller => {
      controller.enqueue(PNG);
      setTimeout(() => controller.error(new TypeError("network error")), 5);
    });
    await expect(runImageJob("https://cdn.example/pic.png", signal(), dropped))
      .rejects.toMatchObject({ code: "network_unreachable", during: "transfer", receivedBytes: PNG.byteLength });
  });

  it("moves a large image into Blobs as it arrives and holds no more than one fold of it as bytes", async () => {
    const append = vi.spyOn(BlobParts.prototype, "append");
    const chunk = new Uint8Array(1024 * 1024).fill(3);
    const chunks = 40;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === chunks) { controller.close(); return; }
        controller.enqueue(sent++ === 0 ? Uint8Array.from([...PNG, ...chunk.subarray(PNG.byteLength)]) : chunk);
      },
    });
    const result = await runImageJob("https://site.example/large.png", signal(), respond(body));
    if (result.kind !== "image") throw new Error("expected an image");
    expect(result.blob.size).toBe(chunks * chunk.byteLength);
    expect(result.blob.type).toBe("image/png");
    // Every chunk went into the folding store; none was kept in a list of its own.
    expect(append).toHaveBeenCalledTimes(chunks);
    expect(FOLD_BYTES).toBeLessThan(chunks * chunk.byteLength);
    append.mockRestore();
  });
});
