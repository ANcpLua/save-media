// @vitest-environment node
//
// Exercises the real merge (mediabunny) through the engine job, driven by a
// mocked fetch that serves committed ffmpeg fixtures and an injected sink.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { runAvMergeJob } from "../../../../src/engine/jobs/av-merge";
import type { JobSink } from "../../../../src/engine/sink";
import type { JobResult } from "../../../../src/engine/job";
import type { AvMergePlan } from "@savemedia/core";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(process.cwd(), "tests/unit/engine/fixtures", name)));

const VIDEO_BYTES = fixture("video-only.mp4"); // H.264
const AUDIO_BYTES = fixture("audio-only.m4a"); // AAC

const VIDEO_URL = "https://cdn.example/video.mp4";
const AUDIO_URL = "https://cdn.example/audio.m4a";

function plan(): AvMergePlan {
  return {
    kind: "av-merge",
    video: { initUrl: null, segmentUrls: [VIDEO_URL] },
    audio: { initUrl: null, segmentUrls: [AUDIO_URL] },
    outputContainer: "mp4",
    outputFilename: "clip.bin",
    estimatedBytes: null,
  };
}

class CapturingSink implements JobSink {
  openedFilename: string | null = null;
  writes: Uint8Array[] = [];
  aborted = false;
  async open(filename: string): Promise<void> { this.openedFilename = filename; }
  async write(bytes: Uint8Array): Promise<void> { this.writes.push(new Uint8Array(bytes)); }
  async close(): Promise<JobResult> {
    return { blobUrl: "blob:unit-test", filename: this.openedFilename ?? "", checksum: "" };
  }
  async abort(): Promise<void> { this.aborted = true; }
  merged(): Uint8Array {
    const total = this.writes.reduce((n, w) => n + w.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const w of this.writes) { out.set(w, off); off += w.byteLength; }
    return out;
  }
}

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function patchFetch(fetcher: (url: string) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => fetcher(String(url))) as unknown as typeof fetch;
}

describe("runAvMergeJob", () => {
  it("fetches both tracks, merges to one MP4 carrying video + audio, and normalises the extension", async () => {
    patchFetch(async url => {
      if (url === VIDEO_URL) return new Response(VIDEO_BYTES as BodyInit, { status: 200 });
      if (url === AUDIO_URL) return new Response(AUDIO_BYTES as BodyInit, { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const sink = new CapturingSink();

    const result = await runAvMergeJob(plan(), vi.fn(), new AbortController().signal, sink);

    expect(result.filename).toBe("clip.mp4"); // .bin → .mp4
    const merged = sink.merged();
    expect(String.fromCharCode(merged[4]!, merged[5]!, merged[6]!, merged[7]!)).toBe("ftyp");

    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(merged) });
    expect(await input.getPrimaryVideoTrack()).not.toBeNull();
    expect(await input.getPrimaryAudioTrack()).not.toBeNull();
  });

  it("reports monotonic byte progress ending in a merging/finalizing phase", async () => {
    patchFetch(async url => new Response((url === VIDEO_URL ? VIDEO_BYTES : AUDIO_BYTES) as BodyInit, { status: 200 }));
    const phases: string[] = [];
    let last = -1;
    let monotonic = true;
    await runAvMergeJob(plan(), (bytes, _total, phase) => {
      phases.push(phase);
      if (bytes < last) monotonic = false;
      last = bytes;
    }, new AbortController().signal, new CapturingSink());

    expect(monotonic).toBe(true);
    expect(phases).toContain("fetching-video");
    expect(phases).toContain("fetching-audio");
    expect(phases.at(-1)).toBe("finalizing");
  });

  it("fails with a terminal error when a segment cannot be fetched", async () => {
    patchFetch(async url => {
      if (url === VIDEO_URL) return new Response("not found", { status: 404 });
      return new Response(AUDIO_BYTES as BodyInit, { status: 200 });
    });

    await expect(runAvMergeJob(plan(), vi.fn(), new AbortController().signal, new CapturingSink()))
      .rejects.toMatchObject({ severity: "terminal" });
  });

  it("aborts before fetching when the signal is already aborted", async () => {
    patchFetch(async () => { throw new Error("should not fetch"); });
    const controller = new AbortController();
    controller.abort();

    await expect(runAvMergeJob(plan(), vi.fn(), controller.signal, new CapturingSink()))
      .rejects.toThrow(/cancel/i);
  });

  it("rejects a track with no segments", async () => {
    patchFetch(async () => new Response(AUDIO_BYTES as BodyInit, { status: 200 }));
    const empty: AvMergePlan = { ...plan(), video: { initUrl: null, segmentUrls: [] } };

    await expect(runAvMergeJob(empty, vi.fn(), new AbortController().signal, new CapturingSink()))
      .rejects.toMatchObject({ code: "manifest_malformed" });
  });
});
