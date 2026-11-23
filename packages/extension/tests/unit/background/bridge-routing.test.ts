import { describe, expect, it } from "vitest";
import { fromShownDocument, observedCapture, privateTargets, resolverCapture, type BridgeSender, type RoutingContext } from "../../../src/background/bridge-routing";

const sender = (over: Partial<BridgeSender> = {}): BridgeSender =>
  ({ url: "https://news.example/story", origin: "https://news.example", tabUrl: "https://news.example/story", frameId: 0, documentId: "doc-1", documentLifecycle: "active", ...over });
const context = (received: Record<string, string | null> = {}, over: Partial<RoutingContext> = {}): RoutingContext => ({
  topUrl: "https://news.example/story",
  isCurrent: (_frameId, documentId) => documentId === "doc-1",
  received: url => Object.hasOwn(received, url) ? { ip: received[url]!, frameId: 0 } : null,
  ...over,
});

describe("what a bridge message may make savemedia request", () => {
  it("drops a report from a document the tab no longer shows", () => {
    expect(fromShownDocument(sender(), context())).toBe(true);
    expect(fromShownDocument(sender({ documentId: "doc-0" }), context())).toBe(false);
    expect(fromShownDocument(sender({ documentLifecycle: "cached" }), context())).toBe(false);
    expect(fromShownDocument(sender({ documentLifecycle: "prerender" }), context())).toBe(false);
  });

  it("takes a file address from a page's MAIN world only on the hosts that have a resolver", () => {
    // Any page can post { __savemedia: true, kind: "media-source", url }: on an ordinary site nothing is requested.
    expect(resolverCapture({ url: "https://bank.example/account/close" }, sender(), context())).toBeNull();
    expect(resolverCapture({ url: "https://cdn.example/a.mp4" }, sender({ url: "https://evil.example/x.com/" }), context())).toBeNull();
    expect(resolverCapture({ url: null }, sender({ url: "https://x.com/user/status/1" }), context())).toBeNull();
    const route = resolverCapture({ url: "https://video.twimg.com/a.mp4" }, sender({ url: "https://x.com/user/status/1", frameId: 3 }),
      context({}, { topUrl: "https://x.com/user/status/1" }));
    expect(route).toMatchObject({ message: { payload: { kind: "media-source", url: "https://video.twimg.com/a.mp4", pageUrl: "https://x.com/user/status/1" } },
      options: { referrerPage: "https://x.com/user/status/1", origin: { frameId: 3, documentId: "doc-1", via: ["resolver"] } } });
  });

  it("requests a resolver's address without cookies unless the browser itself received it, and its audio too", () => {
    const from = sender({ url: "https://x.com/user/status/1" });
    const payload = { url: "https://video.twimg.com/v.mp4", audioUrl: "https://video.twimg.com/a.mp4" };
    expect(resolverCapture(payload, from, context())?.options.credentials).toBe("omit");
    expect(resolverCapture(payload, from, context({ "https://video.twimg.com/v.mp4": null }))?.options.credentials).toBe("omit");
    expect(resolverCapture(payload, from, context({ "https://video.twimg.com/v.mp4": null, "https://video.twimg.com/a.mp4": null }))?.options.credentials).toBe("include");
  });

  it("never follows a resolver host's page into the user's network, to a server the browser was not answered from", () => {
    const from = sender({ url: "https://x.com/user/status/1" });
    expect(resolverCapture({ url: "http://192.168.1.1/apply.cgi" }, from, context())).toBeNull();
    expect(resolverCapture({ url: "https://video.twimg.com/v.mp4", audioUrl: "http://localhost.:8080/a.mp4" }, from, context())).toBeNull();
    // Where the browser itself was answered from that origin in this tab, the address is checked like any other.
    const observedLocal = (url: string): boolean => new URL(url).origin === "http://192.168.1.1";
    expect(resolverCapture({ url: "http://192.168.1.1/apply.cgi" }, from, context({}, { observedLocal }))).not.toBeNull();
    expect(resolverCapture({ url: "http://192.168.1.2/apply.cgi" }, from, context({}, { observedLocal }))).toBeNull();
  });

  it("gives a request from the resource timeline cookies only when the worker saw the browser receive it", () => {
    const seen = observedCapture("https://cdn.example/a.m3u8", "xmlhttprequest", sender({ frameId: 2, url: "https://player.example/embed" }),
      context({ "https://cdn.example/a.m3u8": "93.184.216.34" }));
    expect(seen).toMatchObject({ message: { payload: { url: "https://cdn.example/a.m3u8", pageUrl: "https://news.example/story" } },
      options: { credentials: "include", serverIp: "93.184.216.34", referrerPage: "https://player.example/embed",
        origin: { frameId: 2, via: ["timing", "network-fetch"] } } });
    const unseen = observedCapture("https://cdn.example/b.mp4", "media", sender(), context());
    expect(unseen?.options).toMatchObject({ credentials: "omit", serverIp: null, origin: { via: ["timing", "network-media"] } });
    // A resolver host's page is the resolver's, and a page without an address has nothing to refer to.
    expect(observedCapture("https://cdn.example/b.mp4", "media", sender(), context({}, { topUrl: "https://www.youtube.com/watch?v=1" }))).toBeNull();
    expect(observedCapture("https://cdn.example/b.mp4", "media", sender({ url: "about:blank", tabUrl: undefined }), context({}, { topUrl: undefined }))).toBeNull();
  });

  it("names the requests of a job that a public page points into the user's network", () => {
    const urls = ["https://cdn.example/seg1.ts", "http://10.0.0.5/key.bin", "http://router.local./seg2.ts"];
    expect(privateTargets("https://news.example/story", urls)).toEqual(["http://10.0.0.5/key.bin", "http://router.local./seg2.ts"]);
    expect(privateTargets("http://192.168.1.20:8096/web/", urls)).toEqual([]);
    // A server the browser itself was answered from for this tab is none of them.
    expect(privateTargets("https://news.example/story", urls, url => new URL(url).origin === "http://10.0.0.5")).toEqual(["http://router.local./seg2.ts"]);
  });
});

describe("what a frame may declare about a media address", () => {
  // The top document (0) embeds a player frame (2), which embeds a helper frame (5). An ad frame (7) sits beside the player.
  const frames = { 0: { documentId: "top", url: "https://news.example/story", generation: 0, parent: -1 },
    2: { documentId: "player", url: "https://player.example/embed", generation: 0, parent: 0 },
    5: { documentId: "helper", url: "https://player.example/helper", generation: 0, parent: 2 },
    7: { documentId: "ad", url: "https://ads.evil.example/slot", generation: 0, parent: 0 } };
  const declared = { groupId: "x", height: 16384, filenameHint: "Interview.mp4" };
  const details = { quality: { groupId: "x", height: 16384 }, filenameHint: "Interview.mp4" };

  it("a frame names and groups what it loaded itself, and what the frames inside it loaded", async () => {
    const { declaredDetails } = await import("../../../src/background/bridge-routing");
    expect(declaredDetails({ frameId: 2, ...declared }, 2, frames)).toEqual(details);
    expect(declaredDetails({ frameId: 2, ...declared }, 5, frames)).toEqual(details);
    expect(declaredDetails({ frameId: 0, ...declared }, 5, frames)).toEqual(details);
    // Nothing is known about who loaded it yet: the declaration is the page's first word on it.
    expect(declaredDetails({ frameId: 7, ...declared }, undefined, frames)).toEqual(details);
    expect(declaredDetails({ frameId: 2, groupId: "g" }, 2, frames)).toEqual({ quality: { groupId: "g" } });
    expect(declaredDetails({ frameId: 2 }, 2, frames)).toEqual({});
  });

  it("an embedded frame cannot rename or regroup the video another frame loaded", async () => {
    const { declaredDetails } = await import("../../../src/background/bridge-routing");
    // The ad frame declares the top page's video as its own 16384p rendition with a name of its choosing.
    expect(declaredDetails({ frameId: 7, ...declared }, 0, frames)).toEqual({});
    expect(declaredDetails({ frameId: 7, ...declared }, 2, frames)).toEqual({});
    // Nor does a frame inside the player speak for the player's own video.
    expect(declaredDetails({ frameId: 5, ...declared }, 2, frames)).toEqual({});
  });
});

