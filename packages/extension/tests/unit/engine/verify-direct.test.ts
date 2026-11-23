// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { identifyResponse, refuseProtectedFile, validateDirectBlob } from "../../../src/engine/verify-direct";
import { box, concat, initSegment } from "./helpers/iso-bmff";

const clip = new Uint8Array(readFileSync(new URL("../../e2e/media-fixtures/direct/clip.mp4", import.meta.url)));
const webm = new Uint8Array(readFileSync(new URL("../../e2e/media-fixtures/direct/clip.webm", import.meta.url)));
const signal = () => new AbortController().signal;
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));

/** A fragmented MP4 under a DASH brand: ftyp, moov, then a movie fragment and its media data. */
const dashBrand = box("ftyp", ascii("dash"), [0, 0, 0, 0], ascii("iso6dash"));
const clearInit = initSegment();
const movie = clearInit.subarray(new DataView(clearInit.buffer).getUint32(0));
const singleFileFmp4 = concat(dashBrand, movie, box("moof", box("mfhd", new Array(8).fill(0))), box("mdat", [1, 2, 3, 4]));

/** One EBML element with a 4-byte size. */
function element(id: number[], ...children: (Uint8Array | number[])[]): Uint8Array {
  const payload = concat(...children.map(child => Uint8Array.from(child)));
  return concat(Uint8Array.from(id), Uint8Array.of(0x10, 0, payload.length >> 8, payload.length & 0xff), payload);
}

function matroska(encrypted: boolean): Uint8Array {
  const encodings = encrypted ? [element([0x6d, 0x80], element([0x62, 0x40], element([0x50, 0x33], [1]),
    element([0x50, 0x35], element([0x47, 0xe1], [5]), element([0x47, 0xe2], new Array(16).fill(3)))))] : [];
  const track = element([0xae], element([0xd7], [1]), element([0x86], ascii("V_VP9")), ...encodings);
  const segment = concat(Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0xff), element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], [15, 66, 64])),
    element([0x16, 0x54, 0xae, 0x6b], track), element([0x1f, 0x43, 0xb6, 0x75], element([0xe7], [0])));
  return concat(element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii("webm"))), segment);
}

describe("direct file identification", () => {
  it("decides from magic bytes first, then from what a document looks like", () => {
    expect(identifyResponse(clip.subarray(0, 4096), { "content-type": "text/html" })).toEqual({ kind: "media", container: "mp4" });
    expect(identifyResponse(new TextEncoder().encode("  <html>"), { "content-type": "video/mp4" })).toEqual({ kind: "document", response: "page" });
    expect(identifyResponse(new TextEncoder().encode('{"error":1}'), { "content-type": "video/quicktime" })).toEqual({ kind: "document", response: "data" });
    expect(identifyResponse(clip.subarray(0, 10), { "content-type": "video/mp4" })).toEqual({ kind: "unknown" });
  });

  it("takes a fragmented MP4 under a DASH or CMAF brand for a video file once media follows its movie box", () => {
    expect(identifyResponse(singleFileFmp4, {})).toEqual({ kind: "media", container: "mp4" });
    // The probe ends inside the movie box: the file's length says media follows.
    const head = concat(dashBrand, movie).subarray(0, dashBrand.length + 16);
    expect(identifyResponse(head, { "content-range": `bytes 0-${head.length - 1}/50000000` })).toEqual({ kind: "media", container: "mp4" });
    // An init section alone, or one whose length is unknown, is no video file.
    const init = concat(dashBrand, movie);
    expect(identifyResponse(init, { "content-length": String(init.length) })).toEqual({ kind: "unknown" });
    expect(identifyResponse(head, {})).toEqual({ kind: "unknown" });
  });
});

describe("validateDirectBlob", () => {
  it("accepts the clear fixture", async () => {
    await expect(validateDirectBlob(new Blob([clip]), "mp4", signal())).resolves.toBeUndefined();
  });

  it("accepts a clear single-file fragmented MP4 under a DASH brand", async () => {
    await expect(validateDirectBlob(new Blob([singleFileFmp4 as BlobPart]), "mp4", signal())).resolves.toBeUndefined();
  });

  it("refuses a WebM whose track declares ContentEncryption, and accepts clear WebM", async () => {
    await expect(validateDirectBlob(new Blob([matroska(true) as BlobPart]), "webm", signal()))
      .rejects.toEqual({ code: "encrypted_media_detected", severity: "terminal", detectedVia: ["matroska-protection"], keySystem: null });
    await expect(validateDirectBlob(new Blob([matroska(false) as BlobPart]), "webm", signal())).resolves.toBeUndefined();
    await expect(validateDirectBlob(new Blob([webm as BlobPart]), "webm", signal())).resolves.toBeUndefined();
  });

  it("refuses an MP4 whose movie box declares Common Encryption, even when every box is well formed", async () => {
    const encrypted = new Blob([concat(initSegment({ scheme: "cenc" }), box("mdat", [1, 2, 3, 4])) as BlobPart]);
    await expect(validateDirectBlob(encrypted, "mp4", signal()))
      .rejects.toEqual({ code: "encrypted_media_detected", severity: "terminal", detectedVia: ["mp4-protection"], keySystem: "cenc" });
  });
});

describe("refuseProtectedFile: a track that is one file, checked without reading it into memory", () => {
  const file = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);
  const protectedMp4 = { code: "encrypted_media_detected", severity: "terminal", detectedVia: ["mp4-protection"], keySystem: "cenc" };

  it("finds Common Encryption in a movie box that follows the media", async () => {
    const encrypted = initSegment({ scheme: "cenc" });
    const fileType = encrypted.subarray(0, new DataView(encrypted.buffer).getUint32(0));
    const movieLast = concat(fileType, box("mdat", new Array(5000).fill(9)), encrypted.subarray(fileType.length));
    await expect(refuseProtectedFile(file(movieLast), signal())).rejects.toEqual(protectedMp4);
    await expect(refuseProtectedFile(file(concat(encrypted, box("moof"), box("mdat", [1]))), signal())).rejects.toEqual(protectedMp4);
  });

  it("finds a protection system header that sits beside the movie box", async () => {
    const header = box("pssh", [0, 0, 0, 0], [0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed], [0, 0, 0, 0]);
    await expect(refuseProtectedFile(file(concat(singleFileFmp4, header)), signal()))
      .rejects.toMatchObject({ code: "encrypted_media_detected", keySystem: "com.widevine.alpha" });
  });

  it("finds ContentEncryption in a WebM track", async () => {
    await expect(refuseProtectedFile(file(matroska(true)), signal()))
      .rejects.toEqual({ code: "encrypted_media_detected", severity: "terminal", detectedVia: ["matroska-protection"], keySystem: null });
  });

  it("lets clear files through, and bytes that are no container it reads", async () => {
    for (const clear of [clip, webm, singleFileFmp4, matroska(false), Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 1, 2, 3, 4, 5, 6, 7, 8)]) {
      await expect(refuseProtectedFile(file(clear), signal())).resolves.toBeUndefined();
    }
  });

  it("stops when the save is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(refuseProtectedFile(file(clip), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
