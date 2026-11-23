// @vitest-environment node
//
// A transport stream the MP4 muxer does not finish is kept as it is: the
// save never ends in "Try again" for a failure that every retry repeats.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HlsPlainPlan, VariantId } from "@savemedia/core";
import { runHlsJob } from "../../../../src/engine/jobs/hls";
import { remuxTsToMp4 } from "../../../../src/engine/remux/ts-to-mp4";
import { CapturingSink } from "../helpers/capturing-sink";
import { hlsDescriptor } from "../../popup/helpers/descriptors";

vi.mock("../../../../src/engine/remux/ts-to-mp4", () => ({ remuxTsToMp4: vi.fn() }));

const segment = new Uint8Array(readFileSync(resolve(__dirname, "../../../e2e/media-fixtures/hls/seg000.ts")));
const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:2.0,\nseg.ts\n#EXT-X-ENDLIST\n";
const plan: HlsPlainPlan = { kind: "hls-plain", steps: [], outputContainer: "mp4", outputFilename: "clip.mp4",
  variantId: "v-1080" as VariantId, estimatedBytes: null };

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.mocked(remuxTsToMp4).mockReset(); });

function serve(): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) =>
    new Response(String(url).endsWith(".m3u8") ? playlist : segment as BodyInit)) as unknown as typeof fetch;
}

describe("a transport stream the MP4 muxer does not finish", () => {
  it.each([
    ["stops with an error", () => Promise.reject(new Error("Timestamps cannot be smaller than the largest timestamp of the previous GOP"))],
    ["returns something that is no MP4", () => Promise.resolve(new Blob([new Uint8Array(64)]))],
  ])("is saved with every packet as a .ts file when the muxer %s", async (_name, outcome) => {
    serve();
    vi.mocked(remuxTsToMp4).mockImplementation(outcome);
    const sink = new CapturingSink();
    const result = await runHlsJob(plan, hlsDescriptor(), { onProgress: vi.fn(), signal: new AbortController().signal, sink });
    expect(remuxTsToMp4).toHaveBeenCalledTimes(1);
    expect(result.filename).toBe("clip.ts");
    expect(sink.bytes()).toEqual(segment);
    expect(sink.aborted).toBe(false);
  });

  it("is not saved when the user cancelled while the muxer ran", async () => {
    serve();
    const controller = new AbortController();
    vi.mocked(remuxTsToMp4).mockImplementation(async () => { controller.abort(); throw new Error("stopped"); });
    const sink = new CapturingSink();
    await expect(runHlsJob(plan, hlsDescriptor(), { onProgress: vi.fn(), signal: controller.signal, sink })).rejects.toMatchObject({ name: "AbortError" });
    expect(sink.writes).toHaveLength(0);
  });
});
