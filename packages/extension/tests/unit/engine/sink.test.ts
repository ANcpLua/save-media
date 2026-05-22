import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemorySink } from "../../../src/engine/sink";

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
