import { describe, expect, it, vi } from "vitest";
import { createRefererMirror, isExtractorManagedHost, looksLikeMediaEntryUrl } from "../../../src/background/network-capture";

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

describe("referer mirror", () => {
  function mirror() {
    const updateSessionRules = vi.fn(async (_options: chrome.declarativeNetRequest.UpdateRuleOptions) => {});
    return { updateSessionRules, mirrorReferer: createRefererMirror({ updateSessionRules }, "extension-id") };
  }

  it("gives only the extension's own requests to the media host the page origin as Referer", async () => {
    const { updateSessionRules, mirrorReferer } = mirror();
    await mirrorReferer("https://media.example/v/clip.mp4?token=a", "https://www.example/watch/1");
    const options = updateSessionRules.mock.calls[0]![0];
    const rule = options.addRules![0]!;
    expect(options.removeRuleIds).toEqual([rule.id]);
    expect(rule.action.requestHeaders).toEqual([{ header: "referer", operation: "set", value: "https://www.example/" }]);
    expect(rule.condition).toEqual({ requestDomains: ["media.example"], initiatorDomains: ["extension-id"], tabIds: [-1] });
  });

  it("rewrites a host's rule only when the page origin changes", async () => {
    const { updateSessionRules, mirrorReferer } = mirror();
    await mirrorReferer("https://media.example/a.mp4?token=1", "https://www.example/watch/1");
    await mirrorReferer("https://media.example/b.mp4?token=2", "https://www.example/watch/2");
    expect(updateSessionRules).toHaveBeenCalledTimes(1);
    await mirrorReferer("https://media.example/c.mp4", "https://other.example/embed/3");
    const [first, second] = updateSessionRules.mock.calls.map(([options]) => options.addRules![0]!);
    expect(second!.id).toBe(first!.id);
    expect(second!.action.requestHeaders![0]!.value).toBe("https://other.example/");
  });

  it("tries again after the browser rejected a rule", async () => {
    const updateSessionRules = vi.fn<(options: chrome.declarativeNetRequest.UpdateRuleOptions) => Promise<void>>()
      .mockRejectedValueOnce(new Error("rule limit")).mockResolvedValue(undefined);
    const mirrorReferer = createRefererMirror({ updateSessionRules }, "extension-id");
    await mirrorReferer("https://media.example/clip.mp4", "https://www.example/watch/1");
    await mirrorReferer("https://media.example/clip.mp4", "https://www.example/watch/1");
    expect(updateSessionRules).toHaveBeenCalledTimes(2);
  });

  it("leaves requests alone for pages and media that are not on the web", async () => {
    const { updateSessionRules, mirrorReferer } = mirror();
    await mirrorReferer("https://media.example/clip.mp4", "chrome-extension://abc/src/popup/index.html");
    await mirrorReferer("blob:https://www.example/1234", "https://www.example/watch/1");
    expect(updateSessionRules).not.toHaveBeenCalled();
  });
});
