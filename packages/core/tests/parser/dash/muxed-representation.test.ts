import { describe, expect, it } from "vitest";
import { parseDash } from "../../../src/parser/dash/adapter";
import { dispatch } from "../../../src/engine/dispatch";
import { classify } from "../../../src/classifier/classify";
import type { UserChoice } from "../../../src/types/job";

// One representation that holds video and audio together: the manifest has
// no audio AdaptationSet, and the sound is in the video track's own bytes.
// The e2e serves this layout under /dash-muxed/.
const MPD_URL = "https://x.test/dash-muxed/clip.mpd";
const muxed = (codecs: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S" minBufferTime="PT1S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="av" bandwidth="140000" width="320" height="180" codecs="${codecs}">
        <SegmentTemplate initialization="init.mp4" media="part-$Number$.m4s" startNumber="1" duration="1" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const choice: UserChoice = { outputMode: "Original", filename: "out.mp4", variantId: null, audioRenditionId: null };

async function plan(codecs: string) {
  return dispatch(await classify({
    tabId: 1,
    pageUrl: "https://x.test/page/dash-muxed.html",
    url: MPD_URL,
    headers: { "content-type": "application/dash+xml" },
    bodyBytes: null,
    manifestText: muxed(codecs),
  }), choice);
}

describe("clear DASH whose one representation carries video and audio together", () => {
  it("gives one video variant that states its audio codec, and no audio rendition", () => {
    const parsed = parseDash(muxed("avc1.42c00c,mp4a.40.2"), MPD_URL);
    expect(parsed.audioRenditions).toEqual([]);
    expect(parsed.videoVariants).toHaveLength(1);
    expect(parsed.videoVariants[0]!.videoCodec?.family).toBe("h264");
    expect(parsed.videoVariants[0]!.audioCodec?.family).toBe("aac");
  });

  it("is saved from that one track, whose own audio the merge copies", async () => {
    expect(await plan("avc1.42c00c,mp4a.40.2")).toEqual({
      kind: "av-merge",
      video: { initUrl: "https://x.test/dash-muxed/init.mp4", segmentUrls: ["https://x.test/dash-muxed/part-1.m4s", "https://x.test/dash-muxed/part-2.m4s"] },
      audio: null,
      outputContainer: "mp4",
      outputFilename: "out.mp4",
      estimatedBytes: expect.any(Number),
    });
  });

  it("is refused when the audio it declares is a codec the MP4 muxer does not write, never saved without it", async () => {
    expect(await plan("avc1.42c00c,alac")).toEqual({ kind: "refuse", reason: "codec_unsupported", codec: { track: "audio", family: "alac" } });
  });
});
