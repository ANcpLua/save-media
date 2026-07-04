import { describe, expect, it } from "vitest";
import { resolverForPage } from "../../../../src/content/sites/registry";

describe("resolverForPage", () => {
  it("selects the twitter resolver for x.com / twitter.com pages", () => {
    expect(resolverForPage("https://x.com/user/status/1001")?.id).toBe("twitter");
    expect(resolverForPage("https://twitter.com/user/status/1001")?.id).toBe("twitter");
    expect(resolverForPage("https://mobile.twitter.com/i/web/status/1")?.id).toBe("twitter");
  });

  it("selects the instagram resolver for instagram.com pages", () => {
    expect(resolverForPage("https://www.instagram.com/reel/CxYz/")?.id).toBe("instagram");
    expect(resolverForPage("https://instagram.com/p/CxYz/")?.id).toBe("instagram");
  });

  it("selects the youtube resolver for youtube watch/embed pages", () => {
    expect(resolverForPage("https://www.youtube.com/watch?v=aQb2eDW4kzA")?.id).toBe("youtube");
    expect(resolverForPage("https://m.youtube.com/watch?v=aQb2eDW4kzA")?.id).toBe("youtube");
    expect(resolverForPage("https://www.youtube-nocookie.com/embed/aQb2eDW4kzA")?.id).toBe("youtube");
  });

  it("returns null for ordinary pages and bad URLs", () => {
    expect(resolverForPage("https://example.com")).toBeNull();
    expect(resolverForPage("https://rr3---sn-4g5edned.googlevideo.com/videoplayback?itag=137")).toBeNull();
    expect(resolverForPage("not a url")).toBeNull();
  });
});
