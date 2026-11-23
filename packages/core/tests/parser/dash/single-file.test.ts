import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseDash } from "../../../src/parser/dash/adapter";
import { classify } from "../../../src/classifier/classify";
import { dispatch } from "../../../src/engine/dispatch";

const MPD_URL = "https://cdn.test/vod/clip.mpd";
const choice = { outputMode: "Original" as const, filename: "out.mp4", variantId: null, audioRenditionId: null };

const video = (addressing: string, base = "video.mp4") => `<AdaptationSet contentType="video" mimeType="video/mp4">
  <Representation id="v" bandwidth="800000" codecs="avc1.64001f" width="640" height="360"><BaseURL>${base}</BaseURL>${addressing}</Representation></AdaptationSet>`;
const audio = (addressing: string, base = "audio.mp4") => `<AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
  <Representation id="a" bandwidth="64000" codecs="mp4a.40.2" audioSamplingRate="44100"><BaseURL>${base}</BaseURL>${addressing}</Representation></AdaptationSet>`;
const mpd = (...periods: string[]) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
${periods.map(sets => `<Period>${sets}</Period>`).join("\n")}</MPD>`;

/** The on-demand profile: one file per representation, with the ranges of its index and its header. */
const INDEXED = '<SegmentBase indexRange="800-1000"><Initialization range="0-799"/></SegmentBase>';
/** The same file without an index range. */
const HEADER_ONLY = '<SegmentBase><Initialization range="0-699"/></SegmentBase>';
/** The file as a list of byte ranges: the header from its first byte, then each segment where the one before ends. */
const RANGE_LIST = '<SegmentList duration="5"><Initialization range="0-799"/><SegmentURL mediaRange="800-49999"/><SegmentURL mediaRange="50000-99999"/></SegmentList>';
/** Lists of byte ranges that do not say what the whole file is. */
const BROKEN_RANGE_LISTS: readonly (readonly [string, string])[] = [
  ["a gap between two segments", '<SegmentList duration="5"><Initialization range="0-799"/><SegmentURL mediaRange="800-49999"/><SegmentURL mediaRange="60000-99999"/></SegmentList>'],
  ["a gap after the header", '<SegmentList duration="5"><Initialization range="0-799"/><SegmentURL mediaRange="900-49999"/><SegmentURL mediaRange="50000-99999"/></SegmentList>'],
  ["a header that does not start the file", '<SegmentList duration="5"><Initialization range="100-799"/><SegmentURL mediaRange="800-49999"/><SegmentURL mediaRange="50000-99999"/></SegmentList>'],
  ["segments out of order", '<SegmentList duration="5"><Initialization range="0-799"/><SegmentURL mediaRange="50000-99999"/><SegmentURL mediaRange="800-49999"/></SegmentList>'],
  ["a header kept in another file", '<SegmentList duration="5"><Initialization sourceURL="header.mp4"/><SegmentURL mediaRange="0-49999"/><SegmentURL mediaRange="50000-99999"/></SegmentList>'],
  ["no header", '<SegmentList duration="5"><SegmentURL mediaRange="0-49999"/><SegmentURL mediaRange="50000-99999"/></SegmentList>'],
  ["a segment kept in another file", '<SegmentList duration="5"><Initialization range="0-799"/><SegmentURL mediaRange="800-49999"/><SegmentURL media="other.mp4" mediaRange="50000-99999"/></SegmentList>'],
];

describe("DASH representations that are one file", () => {
  it.each([["an index range", INDEXED], ["a header range only", HEADER_ONLY]])("names the file itself as the track, with %s", (_name, addressing) => {
    const parsed = parseDash(mpd(video(addressing) + audio(addressing)), MPD_URL);
    // No stated end: a SegmentBase file is the track whatever its length.
    expect(parsed.videoVariants.map(track => track.segmentRef)).toEqual([
      { kind: "dash-segments", initUrl: "", mediaUrls: ["https://cdn.test/vod/video.mp4"] }]);
    expect(parsed.audioRenditions.map(track => track.segmentRef)).toEqual([
      { kind: "dash-segments", initUrl: "", mediaUrls: ["https://cdn.test/vod/audio.mp4"] }]);
  });

  it("estimates the size from the bitrate and the presentation's length", () => {
    const parsed = parseDash(mpd(video(INDEXED) + audio(INDEXED)), MPD_URL);
    expect(parsed.videoVariants[0]!.estimatedSize).toBe(1_000_000);
    expect(parsed.audioRenditions[0]!.estimatedSize).toBe(80_000);
  });

  it("is saved as a merge of the two files, each read whole", async () => {
    const descriptor = await classify({ tabId: 1, pageUrl: "https://site.test/watch", url: MPD_URL,
      headers: { "content-type": "application/dash+xml" }, bodyBytes: null, manifestText: mpd(video(INDEXED) + audio(INDEXED)) });
    expect(dispatch(descriptor, choice)).toMatchObject({
      kind: "av-merge",
      video: { initUrl: null, segmentUrls: ["https://cdn.test/vod/video.mp4"] },
      audio: { initUrl: null, segmentUrls: ["https://cdn.test/vod/audio.mp4"] },
    });
  });

  it("leaves a manifest of several periods unmaterialized: each period names a file of its own, and one of them is not the video", () => {
    const parsed = parseDash(mpd(video(INDEXED, "part1.mp4"), video(INDEXED, "part2.mp4")), MPD_URL);
    for (const track of parsed.videoVariants) {
      expect(track.segmentRef).toEqual({ kind: "dash-segments", initUrl: "", mediaUrls: [] });
    }
  });

  it("reads a list of byte ranges that covers the file from its start without a gap as that file, up to the stated end", async () => {
    const text = mpd(video(RANGE_LIST) + audio(RANGE_LIST));
    const parsed = parseDash(text, MPD_URL);
    expect(parsed.videoVariants[0]!.segmentRef).toEqual(
      { kind: "dash-segments", initUrl: "", mediaUrls: ["https://cdn.test/vod/video.mp4"], fileBytes: 100_000 });
    expect(parsed.audioRenditions[0]!.segmentRef).toEqual(
      { kind: "dash-segments", initUrl: "", mediaUrls: ["https://cdn.test/vod/audio.mp4"], fileBytes: 100_000 });
    const descriptor = await classify({ tabId: 1, pageUrl: "https://site.test/watch", url: MPD_URL,
      headers: { "content-type": "application/dash+xml" }, bodyBytes: null, manifestText: text });
    expect(dispatch(descriptor, choice)).toMatchObject({
      kind: "av-merge",
      video: { initUrl: null, segmentUrls: ["https://cdn.test/vod/video.mp4"], fileBytes: 100_000 },
      audio: { initUrl: null, segmentUrls: ["https://cdn.test/vod/audio.mp4"], fileBytes: 100_000 },
    });
  });

  it.each(BROKEN_RANGE_LISTS)("leaves byte ranges with %s unmaterialized, which dispatch refuses as a layout it cannot assemble", async (_name, list) => {
    const text = mpd(video(list));
    expect(parseDash(text, MPD_URL).videoVariants[0]!.segmentRef).toEqual({ kind: "dash-segments", initUrl: "", mediaUrls: [] });
    const descriptor = await classify({ tabId: 1, pageUrl: "https://site.test/watch", url: MPD_URL,
      headers: { "content-type": "application/dash+xml" }, bodyBytes: null, manifestText: text });
    expect(dispatch(descriptor, choice)).toEqual({ kind: "refuse", reason: "dash_unsupported" });
  });

  it("leaves a manifest that is still being written unmaterialized, whatever its addressing", () => {
    const live = mpd(video(INDEXED)).replace('type="static"', 'type="dynamic"');
    const parsed = parseDash(live, MPD_URL);
    expect(parsed.presentation.live).toBe(true);
    expect(parsed.videoVariants[0]!.segmentRef).toEqual({ kind: "dash-segments", initUrl: "", mediaUrls: [] });
  });
});

// The two manifests the e2e serves for one pair of files (scripts/generate-dash-fixtures.mjs, single-file):
// ffmpeg's own, a list of byte ranges, and the on-demand profile's, which names the index range.
describe("the single-file DASH fixture's manifests", () => {
  const fixture = (name: string) => readFileSync(new URL(`../../fixtures/dash/${name}`, import.meta.url), "utf-8");
  const URL_OF = "https://x.test/dash-single-file/clip.mpd";

  it.each([
    ["byte ranges", "clear-single-file-ranges.mpd", { video: { fileBytes: 27860 }, audio: { fileBytes: 9725 } }],
    ["an index range", "clear-single-file-indexed.mpd", { video: {}, audio: {} }],
  ])("described by %s, is saved as a merge of the two files", async (_name, file, stated) => {
    const descriptor = await classify({ tabId: 1, pageUrl: "https://x.test/page/dash-single-file.html", url: URL_OF,
      headers: { "content-type": "application/dash+xml" }, bodyBytes: null, manifestText: fixture(file) });
    expect(descriptor.drm).toBeNull();
    expect(dispatch(descriptor, choice)).toEqual({
      kind: "av-merge",
      video: { initUrl: null, segmentUrls: ["https://x.test/dash-single-file/clip-stream0.mp4"], ...stated.video },
      audio: { initUrl: null, segmentUrls: ["https://x.test/dash-single-file/clip-stream1.mp4"], ...stated.audio },
      outputContainer: "mp4",
      outputFilename: "out.mp4",
      estimatedBytes: expect.any(Number),
    });
  });
});
