// @vitest-environment node
//
// Playlists whose parts are byte ranges of one file (EXT-X-BYTERANGE): the
// file is the stream, read once. Runs in node because the job reads Blobs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HlsPlainPlan, VariantId } from "@savemedia/core";
import { runHlsJob } from "../../../../src/engine/jobs/hls";
import { CapturingSink } from "../helpers/capturing-sink";
import { box, concat, fragment, initSegment } from "../helpers/iso-bmff";
import { hlsDescriptor } from "../../popup/helpers/descriptors";
import { noWaits } from "../../helpers/waits";

const plan: HlsPlainPlan = { kind: "hls-plain", steps: [], outputContainer: "mp4", outputFilename: "out.mp4",
  variantId: "v-1080" as VariantId, estimatedBytes: null };
const ranged = (lines: string[]) => ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:10", ...lines, "#EXT-X-ENDLIST", ""].join("\n");

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Serves `playlist` for the playlist's address and `body()` for every other; returns the names requested. */
function serve(playlist: string, body: () => Response): string[] {
  const requested: string[] = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    requested.push(String(url).split("/").at(-1)!);
    return String(url).endsWith(".m3u8") ? new Response(playlist) : body();
  }) as unknown as typeof fetch;
  return requested;
}

const run = (sink = new CapturingSink()) => runHlsJob(plan, hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });
const bytes = (payload: Uint8Array) => new Response(payload as BodyInit);

describe("a fragmented MP4 playlist whose parts are byte ranges of one file", () => {
  const file = concat(initSegment(), fragment([1, 2, 3]), fragment([4, 5, 6, 7]));
  const header = initSegment().length;
  const first = fragment([1, 2, 3]).length;
  const ONE_FILE = ranged([`#EXT-X-MAP:URI="clip.mp4",BYTERANGE="${header}@0"`, "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${first}@${header}`, "clip.mp4",
    "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${file.length - header - first}`, "clip.mp4"]);

  it("asks for the file once and saves it as it is, not once for every range", async () => {
    const requested = serve(ONE_FILE, () => bytes(file));
    const sink = new CapturingSink();
    const result = await run(sink);
    expect(requested).toEqual(["master.m3u8", "clip.mp4"]);
    expect(result.filename).toBe("out.mp4");
    expect(sink.bytes()).toEqual(file);
  });

  it("saves the bytes the ranges name and no more, when the file goes on after them", async () => {
    serve(ONE_FILE, () => bytes(concat(file, fragment([9, 9, 9]))));
    const sink = new CapturingSink();
    await run(sink);
    expect(sink.bytes()).toEqual(file);
  });

  it("reports a file that ends before its ranges do as a transfer that stopped, and writes nothing", async () => {
    noWaits();
    serve(ONE_FILE, () => bytes(file.slice(0, file.length - 4)));
    const sink = new CapturingSink();
    await expect(run(sink)).rejects.toMatchObject({ code: "network_unreachable", phase: "segment", during: "transfer",
      receivedBytes: file.length - 4, totalBytes: file.length });
    expect(sink.writes).toHaveLength(0);
  });

  it("refuses a file whose movie box declares Common Encryption, and a page sent in its place", async () => {
    const encrypted = concat(initSegment({ scheme: "cbcs" }), fragment([1, 2, 3]));
    const size = initSegment({ scheme: "cbcs" }).length;
    serve(ranged([`#EXT-X-MAP:URI="clip.mp4",BYTERANGE="${size}@0"`, "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${encrypted.length - size}@${size}`, "clip.mp4"]),
      () => bytes(encrypted));
    const sink = new CapturingSink();
    await expect(run(sink)).rejects.toMatchObject({ code: "encrypted_media_detected", detectedVia: ["mp4-protection"] });
    expect(sink.writes).toHaveLength(0);

    serve(ONE_FILE, () => new Response("<html><body>Please sign in</body></html>"));
    await expect(run()).rejects.toEqual({ code: "unexpected_media_response", severity: "terminal", response: "page" });
  });

  // A packager's one-file output: the playlist names the header and the parts, and leaves the file's index between them out.
  describe("with stretches of the file the ranges leave out", () => {
    const second = fragment([4, 5, 6, 7]).length;
    const layout = (...between: Uint8Array[]) => {
      const gap = concat(...between).length;
      const whole = concat(initSegment(), ...between, fragment([1, 2, 3]), fragment([4, 5, 6, 7]));
      const playlist = ranged([`#EXT-X-MAP:URI="clip.mp4",BYTERANGE="${header}@0"`, "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${first}@${header + gap}`, "clip.mp4",
        "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${second}`, "clip.mp4"]);
      return { whole, playlist };
    };
    const refusal = { code: "hls_layout_unsupported", severity: "terminal", manifestUrl: "https://example.com/master.m3u8", layout: "byte-ranges" };

    it.each([
      ["the segment index", [box("sidx", new Array(60).fill(0))]],
      ["an index, free space and an event message", [box("sidx", new Array(60).fill(0)), box("free", [0, 0, 0, 0]), box("emsg", new Array(20).fill(1))]],
    ])("saves the file as it is, read once, when they hold %s", async (_name, between) => {
      const { whole, playlist } = layout(...between);
      const requested = serve(playlist, () => bytes(whole));
      const sink = new CapturingSink();
      const result = await run(sink);
      expect(requested).toEqual(["master.m3u8", "clip.mp4"]);
      expect(result.filename).toBe("out.mp4");
      expect(sink.bytes()).toEqual(whole);
    });

    it("saves it when the index is left out between two parts as well", async () => {
      const index = box("sidx", new Array(60).fill(0));
      const whole = concat(initSegment(), index, fragment([1, 2, 3]), index, fragment([4, 5, 6, 7]));
      const at = header + index.length;
      serve(ranged([`#EXT-X-MAP:URI="clip.mp4",BYTERANGE="${header}@0"`, "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${first}@${at}`, "clip.mp4",
        "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${second}@${at + first + index.length}`, "clip.mp4"]), () => bytes(whole));
      const sink = new CapturingSink();
      await run(sink);
      expect(sink.bytes()).toEqual(whole);
    });

    it.each([
      ["a fragment the playlist does not name", [fragment([8, 8, 8])]],
      ["media data", [box("mdat", [1, 2, 3, 4])]],
      ["a box of a kind that is not known to be empty of media", [box("uuid", new Array(24).fill(0))]],
      ["a box cut by the next range", [box("sidx", new Array(60).fill(0)).slice(0, 40)]],
      ["fewer bytes than a box header", [new Uint8Array(5)]],
      ["a box that claims to run to the end of the file", [Uint8Array.from([0, 0, 0, 0, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 0])]],
    ])("refuses the file and writes nothing when they hold %s", async (_name, between) => {
      const { whole, playlist } = layout(...between);
      serve(playlist, () => bytes(whole));
      const sink = new CapturingSink();
      await expect(run(sink)).rejects.toEqual(refusal);
      expect(sink.writes).toHaveLength(0);
    });

    it("refuses ranges that overlap or go back, and a header that does not start the file, and requests none of them", async () => {
      for (const lines of [
        [`#EXT-X-MAP:URI="clip.mp4",BYTERANGE="${header}@0"`, "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${first}@${header - 4}`, "clip.mp4"],
        [`#EXT-X-MAP:URI="clip.mp4",BYTERANGE="${header}@0"`, "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${second}@${header + first}`, "clip.mp4",
          "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${first}@${header}`, "clip.mp4"],
        [`#EXT-X-MAP:URI="clip.mp4",BYTERANGE="${header}@16"`, "#EXTINF:2.0,", `#EXT-X-BYTERANGE:${first}@${header + 16}`, "clip.mp4"],
      ]) {
        const requested = serve(ranged(lines), () => bytes(file));
        await expect(run()).rejects.toEqual(refusal);
        expect(requested).toEqual(["master.m3u8"]);
      }
    });
  });
});

describe("a transport stream playlist whose parts are byte ranges of one file", () => {
  const stream = new Uint8Array(readFileSync(resolve(__dirname, "../../../e2e/media-fixtures/transport/timed-id3.ts")));
  const cut = 188 * 40;
  const ONE_FILE = ranged(["#EXTINF:5.0,", `#EXT-X-BYTERANGE:${cut}@0`, "clip.ts", "#EXTINF:5.0,", `#EXT-X-BYTERANGE:${stream.length - cut}@${cut}`, "clip.ts"]);

  it("reads the file once and remuxes all of it, to the file a playlist with one address per part gives", async () => {
    const requested = serve(ONE_FILE, () => bytes(stream));
    const sink = new CapturingSink();
    const result = await run(sink);
    expect(requested).toEqual(["master.m3u8", "clip.ts"]);
    expect(result.filename).toBe("out.mp4");

    serve(ranged(["#EXTINF:10.0,", "clip.ts"]), () => bytes(stream));
    const whole = new CapturingSink();
    await run(whole);
    expect(sink.bytes()).toEqual(whole.bytes());
  });

  it("refuses ranges of a transport stream that leave a gap, and requests none of them: its packets have no index to leave out", async () => {
    const requested = serve(ranged(["#EXTINF:5.0,", `#EXT-X-BYTERANGE:${cut}@0`, "clip.ts", "#EXTINF:5.0,", `#EXT-X-BYTERANGE:${stream.length - cut - 188}@${cut + 188}`, "clip.ts"]),
      () => bytes(stream));
    await expect(run()).rejects.toEqual({ code: "hls_layout_unsupported", severity: "terminal",
      manifestUrl: "https://example.com/master.m3u8", layout: "byte-ranges" });
    expect(requested).toEqual(["master.m3u8"]);
  });

  it("names bytes that are no transport stream instead of trusting the playlist", async () => {
    serve(ONE_FILE, () => bytes(Uint8Array.from({ length: stream.length }, () => 0xde)));
    await expect(run()).rejects.toEqual({ code: "hls_layout_unsupported", severity: "terminal",
      manifestUrl: "https://example.com/master.m3u8", layout: "not-transport-stream" });
  });
});
