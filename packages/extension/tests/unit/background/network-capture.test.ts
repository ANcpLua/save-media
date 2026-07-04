import { describe, expect, it } from "vitest";
import { isExtractorManagedHost, looksLikeMediaEntryUrl } from "../../../src/background/network-capture";

describe("background network capture URL filter", () => {
  it("captures manifest and standalone media entry URLs", () => {
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/master.m3u8")).toBe(true);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/manifest.mpd?token=1")).toBe(true);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/movie.mp4#t=0", "media")).toBe(true);
  });

  it("does not capture HLS/DASH segment URLs as standalone downloads", () => {
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/seg-1.ts")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/chunk-1.m4s")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://video.example/hls/init.mp4")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://video.example/hls/720p.av1.mp4/init-v1-a1.mp4")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://video.example/hls/720p.av1.mp4/seg-22-v1-a1.mp4")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/video/movie.mp4", "xmlhttprequest")).toBe(false);
  });

  it("does not capture standalone audio files as video entries", () => {
    expect(looksLikeMediaEntryUrl("https://cdn.example/audio/track.mp3")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/audio/track.m4a")).toBe(false);
    expect(looksLikeMediaEntryUrl("https://cdn.example/audio/segment-01.aac")).toBe(false);
  });
});

describe("extractor-managed host gate", () => {
  it("recognises resolver-owned pages so generic discovery is suppressed", () => {
    expect(isExtractorManagedHost("https://x.com/user/status/1")).toBe(true);
    expect(isExtractorManagedHost("https://twitter.com/i/web/status/1")).toBe(true);
    expect(isExtractorManagedHost("https://mobile.twitter.com/home")).toBe(true);
    expect(isExtractorManagedHost("https://www.instagram.com/reel/CxYz/")).toBe(true);
    expect(isExtractorManagedHost("https://www.youtube.com/watch?v=1")).toBe(true);
    expect(isExtractorManagedHost("https://m.youtube.com/watch?v=1")).toBe(true);
    expect(isExtractorManagedHost("https://www.youtube-nocookie.com/embed/aQb2eDW4kzA")).toBe(true);
    // The youtube media CDN: `pageUrlFor` can fall back to the request URL
    // itself, and those fetches must not enter generic discovery either.
    expect(isExtractorManagedHost("https://rr3---sn-4g5edned.googlevideo.com/videoplayback?itag=137")).toBe(true);
  });

  it("leaves every other page to the generic path", () => {
    expect(isExtractorManagedHost("https://cdn.example/video/master.m3u8")).toBe(false);
    expect(isExtractorManagedHost("https://x.com.evil.com/")).toBe(false);
    expect(isExtractorManagedHost("https://youtube.com.evil.com/watch?v=1")).toBe(false);
    expect(isExtractorManagedHost("garbage")).toBe(false);
  });
});
