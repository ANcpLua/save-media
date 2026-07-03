import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { instagramResolver } from "../../../../src/content/sites/instagram";

const mediaInfo = readFileSync(
  resolve(process.cwd(), "tests/unit/content/sites/fixtures/instagram-media.json"),
  "utf-8",
);

describe("instagram resolver", () => {
  it("owns instagram.com and subdomains only", () => {
    expect(instagramResolver.ownsHost("instagram.com")).toBe(true);
    expect(instagramResolver.ownsHost("www.instagram.com")).toBe(true);
    expect(instagramResolver.ownsHost("scontent.cdninstagram.com")).toBe(false);
    expect(instagramResolver.ownsHost("instagram.com.evil.com")).toBe(false);
  });

  it("matches GraphQL and /api/v1/ response URLs", () => {
    expect(instagramResolver.matchesApi("https://www.instagram.com/graphql/query")).toBe(true);
    expect(instagramResolver.matchesApi("https://i.instagram.com/api/v1/media/123/info/")).toBe(true);
    expect(instagramResolver.matchesApi("https://www.instagram.com/reel/CxYz/")).toBe(false);
  });

  it("picks the widest progressive video version and ignores DASH", () => {
    const media = instagramResolver.parse(mediaInfo);

    expect(media).toHaveLength(1);
    expect(media[0]?.url).toBe("https://scontent.cdninstagram.com/o1/v/t16/720.mp4?efg=abc&_nc_ht=x");
    expect(media[0]?.width).toBe(720);
    expect(media[0]?.height).toBe(1280);
    expect(media[0]?.site).toBe("instagram");
    // The thumbnail image and the DASH manifest string are never surfaced.
    expect(media.some(m => m.url.includes(".jpg"))).toBe(false);
  });

  it("returns nothing for non-JSON or media-free bodies", () => {
    expect(instagramResolver.parse("<html/>")).toEqual([]);
    expect(instagramResolver.parse(JSON.stringify({ data: {} }))).toEqual([]);
  });
});
