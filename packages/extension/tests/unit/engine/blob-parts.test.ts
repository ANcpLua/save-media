// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BlobParts, FOLD_BYTES, PositionedBlob } from "../../../src/engine/blob-parts";

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe("BlobParts", () => {
  it("joins byte arrays and Blobs in the order they were appended", async () => {
    const parts = new BlobParts();
    parts.append(new Uint8Array([1, 2]));
    parts.append(new Blob([new Uint8Array([3, 4, 5])]));
    parts.append(new Uint8Array([6]));
    expect(parts.size).toBe(6);
    const blob = parts.toBlob("video/mp4");
    expect(blob.type).toBe("video/mp4");
    expect(await bytesOf(blob)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("holds less than the fold size as byte arrays however much is appended", () => {
    const parts = new BlobParts();
    const held = () => (parts as unknown as { pendingBytes: number }).pendingBytes;
    const chunk = new Uint8Array(1024 * 1024);
    let most = 0;
    for (let i = 0; i < 40; i++) {
      parts.append(chunk);
      most = Math.max(most, held());
    }
    expect(parts.size).toBe(40 * chunk.byteLength);
    expect(most).toBeLessThan(FOLD_BYTES);
    expect(parts.toBlob().size).toBe(40 * chunk.byteLength);
  });

  it("can be read while it grows, and starts over after clear", async () => {
    const parts = new BlobParts();
    parts.append(new Uint8Array([1]));
    expect(await bytesOf(parts.toBlob())).toEqual(new Uint8Array([1]));
    parts.append(new Uint8Array([2]));
    expect(await bytesOf(parts.toBlob())).toEqual(new Uint8Array([1, 2]));
    parts.clear();
    expect(parts.size).toBe(0);
    expect(parts.toBlob().size).toBe(0);
  });
});

describe("PositionedBlob", () => {
  it("lays a later write over the bytes it names, as a muxer fills in a header at the end", async () => {
    const file = new PositionedBlob();
    file.write(new Uint8Array([1, 2, 3, 4]), 0);
    file.write(new Uint8Array([5, 6, 7, 8]), 4);
    file.write(new Uint8Array([9, 9]), 2);
    expect(file.size).toBe(8);
    expect(await bytesOf(file.toBlob())).toEqual(new Uint8Array([1, 2, 9, 9, 5, 6, 7, 8]));
  });

  it("lets a write that starts inside the file run past its end", async () => {
    const file = new PositionedBlob();
    file.write(new Uint8Array([1, 2, 3]), 0);
    file.write(new Uint8Array([7, 8, 9]), 2);
    expect(await bytesOf(file.toBlob())).toEqual(new Uint8Array([1, 2, 7, 8, 9]));
  });

  it("fills a gap with zero bytes and applies overlapping writes in the order written", async () => {
    const file = new PositionedBlob();
    file.write(new Uint8Array([1]), 0);
    file.write(new Uint8Array([5]), 3);
    file.write(new Uint8Array([7, 7]), 1);
    file.write(new Uint8Array([8]), 2);
    expect(await bytesOf(file.toBlob())).toEqual(new Uint8Array([1, 7, 8, 5]));
  });

  it("does not keep a view of the caller's buffer for a header it patches", async () => {
    const file = new PositionedBlob();
    file.write(new Uint8Array(8), 0);
    const patch = new Uint8Array([1, 2]);
    file.write(patch, 0);
    patch.fill(9);
    expect(await bytesOf(file.toBlob())).toEqual(new Uint8Array([1, 2, 0, 0, 0, 0, 0, 0]));
  });
});
