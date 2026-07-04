// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.youtube.com/watch?v=demo"}
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// main.ts is the MAIN-world entry: importing it wires the site interceptor
// against `location` and posts captures via window.postMessage. Drive that
// path end-to-end — a stubbed fetch returns an InnerTube player body, the
// bridge messages come out — to pin the emit-side demuxed-pair invariant.

interface BridgeMessage {
  readonly kind: string;
  readonly url: string | null;
  readonly audioUrl?: string;
}

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

function playerBody(videoId: string, videoUrl: string, audioUrl: string): string {
  return JSON.stringify({
    videoDetails: { videoId },
    streamingData: {
      adaptiveFormats: [
        { itag: 137, url: videoUrl, mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, bitrate: 4347552 },
        { itag: 140, url: audioUrl, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130268 },
      ],
    },
  });
}

let responseBody = "";
let posted: BridgeMessage[] = [];
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeAll(async () => {
  // The interceptor wraps window.fetch once at import, so the stub must be
  // in place before main.ts runs.
  window.fetch = (() => Promise.resolve({
    clone: () => ({ text: async () => responseBody }),
  } as unknown as Response)) as typeof fetch;
  await import("../../../src/content/main");
});

beforeEach(() => {
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation(message => {
    posted.push(message as BridgeMessage);
  });
});

describe("content entry — resolver capture emit", () => {
  it("emits a demuxed pair as one media-source capture carrying both URLs", async () => {
    responseBody = playerBody(
      "pair-demo",
      "https://rr1.googlevideo.com/videoplayback?itag=137&v=pair",
      "https://rr1.googlevideo.com/videoplayback?itag=140&v=pair",
    );
    await window.fetch(PLAYER_URL);
    await flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.kind).toBe("media-source");
    expect(posted[0]!.url).toContain("itag=137");
    expect(posted[0]!.audioUrl).toContain("itag=140");
  });

  it("drops a pair whose audio half is empty instead of degrading it to video-only", async () => {
    // An itag-140 entry with url:"" passes the resolver's type-only check and
    // canonicalises to nothing; emitting the video half alone would surface a
    // silent MP4 as a progressive direct download.
    responseBody = playerBody("empty-audio-demo", "https://rr1.googlevideo.com/videoplayback?itag=137&v=empty-audio", "");
    await window.fetch(PLAYER_URL);
    await flush();

    expect(posted).toEqual([]);
  });

  it("does not re-emit the same video when the player re-fetch carries freshly signed URLs", async () => {
    // YouTube re-fetches /youtubei/v1/player for the same video (SPA re-nav,
    // playback recovery) and each response re-signs the videoplayback URLs
    // (expire/sig/n differ). URL-keyed dedupe would pass the re-emission and
    // the popup would list the one video twice.
    responseBody = playerBody(
      "resign-demo",
      "https://rr1.googlevideo.com/videoplayback?expire=111&itag=137&sig=AAA",
      "https://rr1.googlevideo.com/videoplayback?expire=111&itag=140&sig=BBB",
    );
    await window.fetch(PLAYER_URL);
    responseBody = playerBody(
      "resign-demo",
      "https://rr2.googlevideo.com/videoplayback?expire=222&itag=137&sig=CCC",
      "https://rr2.googlevideo.com/videoplayback?expire=222&itag=140&sig=DDD",
    );
    await window.fetch(PLAYER_URL);
    await flush();

    expect(posted).toHaveLength(1);
  });

  it("keeps distinct videos distinct — the stable key never collapses across video ids", async () => {
    responseBody = playerBody(
      "distinct-a",
      "https://rr1.googlevideo.com/videoplayback?itag=137&sig=AAA",
      "https://rr1.googlevideo.com/videoplayback?itag=140&sig=BBB",
    );
    await window.fetch(PLAYER_URL);
    responseBody = playerBody(
      "distinct-b",
      "https://rr1.googlevideo.com/videoplayback?itag=137&sig=CCC",
      "https://rr1.googlevideo.com/videoplayback?itag=140&sig=DDD",
    );
    await window.fetch(PLAYER_URL);
    await flush();

    expect(posted).toHaveLength(2);
  });
});
