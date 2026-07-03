import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { twitterResolver } from "../../../../src/content/sites/twitter";

const tweetDetail = readFileSync(
  resolve(process.cwd(), "tests/unit/content/sites/fixtures/twitter-tweetdetail.json"),
  "utf-8",
);

describe("twitter resolver", () => {
  it("owns twitter.com / x.com and their subdomains, not the CDN", () => {
    expect(twitterResolver.ownsHost("x.com")).toBe(true);
    expect(twitterResolver.ownsHost("twitter.com")).toBe(true);
    expect(twitterResolver.ownsHost("mobile.twitter.com")).toBe(true);
    expect(twitterResolver.ownsHost("video.twimg.com")).toBe(false);
    expect(twitterResolver.ownsHost("notx.com")).toBe(false);
    expect(twitterResolver.ownsHost("youtube.com")).toBe(false);
  });

  it("matches only GraphQL response URLs", () => {
    expect(twitterResolver.matchesApi("https://x.com/i/api/graphql/abc123/TweetDetail?variables=%7B%7D")).toBe(true);
    expect(twitterResolver.matchesApi("https://api.x.com/graphql/def/TweetResultByRestId")).toBe(true);
    expect(twitterResolver.matchesApi("https://x.com/home")).toBe(false);
    expect(twitterResolver.matchesApi("https://video.twimg.com/ext_tw_video/1/pu/vid/720/x.mp4")).toBe(false);
  });

  it("picks the highest-bitrate progressive MP4 per video and ignores the HLS master", () => {
    const media = twitterResolver.parse(tweetDetail);

    // 1280x720 high.mp4 (shared by tweet + its retweet → deduped once) and the
    // 720x1280 portrait clip. The HLS-only and no-mp4 entries yield nothing.
    expect(media).toHaveLength(2);

    const high = media.find(m => m.url.includes("1280x720"));
    expect(high).toBeDefined();
    // The same 1280x720 asset appears in the tweet and its retweet; it is
    // deduped to a single entry (which copy's `?tag=` token wins is immaterial).
    expect(high?.url).toMatch(/^https:\/\/video\.twimg\.com\/ext_tw_video\/1001\/pu\/vid\/1280x720\/high\.mp4/);
    expect(high?.width).toBe(1280);
    expect(high?.height).toBe(720);
    expect(high?.bitrate).toBe(2176000);
    expect(high?.site).toBe("twitter");

    const portrait = media.find(m => m.url.includes("portrait"));
    expect(portrait?.width).toBe(720);
    expect(portrait?.height).toBe(1280);

    // Never surfaces the HLS master or lower-bitrate variants.
    expect(media.some(m => m.url.includes(".m3u8"))).toBe(false);
    expect(media.some(m => m.url.includes("low.mp4") || m.url.includes("mid.mp4"))).toBe(false);
  });

  it("returns nothing for non-JSON or media-free bodies", () => {
    expect(twitterResolver.parse("<html>not json</html>")).toEqual([]);
    expect(twitterResolver.parse(JSON.stringify({ data: { user: { name: "x" } } }))).toEqual([]);
  });
});
