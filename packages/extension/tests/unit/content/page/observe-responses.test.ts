import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { observeResponses, type ResponseWatcher } from "../../../../src/content/page/observe-responses";
import { adWatcher } from "../../../../src/content/page/ad-watcher";
import { extractCaptures, resolverWatcher } from "../../../../src/content/page/resolver-watcher";
import { twitterResolver } from "../../../../src/content/sites/twitter";

const tweetDetail = readFileSync(resolve(process.cwd(), "tests/unit/content/sites/fixtures/twitter-tweetdetail.json"), "utf-8");
const GRAPHQL_URL = "https://x.com/i/api/graphql/abc/TweetDetail";
const flush = async () => { for (let turn = 0; turn < 6; turn++) await new Promise(resolve => setTimeout(resolve, 0)); };

function target(respond: (url: string) => Response) {
  const original = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
  const holder = { fetch: original as unknown as typeof fetch, XMLHttpRequest: class {} as unknown as typeof XMLHttpRequest };
  return { holder, original };
}

const recorder = (wants: ResponseWatcher["wants"], maxChars?: number) => {
  const read = vi.fn<ResponseWatcher["read"]>();
  return { watcher: { wants, read, ...(maxChars ? { maxChars } : {}) } satisfies ResponseWatcher, read };
};

describe("extractCaptures", () => {
  it("returns resolver media for a matching URL, nothing for another URL, and swallows resolver errors", () => {
    expect(extractCaptures(twitterResolver, GRAPHQL_URL, tweetDetail).length).toBeGreaterThan(0);
    expect(extractCaptures(twitterResolver, "https://x.com/home", tweetDetail)).toEqual([]);
    const throwing = { ...twitterResolver, parse: () => { throw new Error("shape changed"); } };
    expect(extractCaptures(throwing, GRAPHQL_URL, tweetDetail)).toEqual([]);
  });
});

describe("observing the responses a page receives", () => {
  it("hands the page its own promise and the same Response object, untouched", async () => {
    const response = new Response("{}", { headers: { "content-type": "application/json" } });
    const { holder, original } = target(() => response);
    observeResponses([recorder(() => true).watcher], holder);
    const promise = holder.fetch("https://site.test/api");
    expect(await promise).toBe(response);
    expect(original).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("{}");
  });

  it("clones a response only when a watcher wants its address and type", async () => {
    const wanted = new Response("<VAST/>", { headers: { "content-type": "text/xml" } });
    const other = new Response("body { }", { headers: { "content-type": "text/css" } });
    const cloneWanted = vi.spyOn(wanted, "clone");
    const cloneOther = vi.spyOn(other, "clone");
    const { holder } = target(url => url.endsWith("vast.xml") ? wanted : other);
    const { watcher, read } = recorder((_url, type) => type.includes("xml"));
    observeResponses([watcher], holder);
    await holder.fetch("https://site.test/ads/vast.xml");
    await holder.fetch("https://site.test/style.css");
    await flush();
    expect(cloneWanted).toHaveBeenCalledTimes(1);
    expect(cloneOther).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith("https://site.test/ads/vast.xml", "<VAST/>");
  });

  it("reads at most the watcher's limit of a body and lets go of the rest", async () => {
    const { holder } = target(() => new Response("x".repeat(5000), { headers: { "content-type": "text/plain" } }));
    const { watcher, read } = recorder(() => true, 1000);
    observeResponses([watcher], holder);
    await holder.fetch("https://site.test/big.txt");
    await flush();
    expect((read.mock.calls[0]![1] as string).length).toBe(1000);
  });

  it("asks a watcher again after the first part of a body, and drops a body nobody wants unread", async () => {
    let pulled = 0;
    const body = () => new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode(pulled === 1 ? `{"items":[` : `"x",`));
        if (pulled > 400) controller.close();
      },
    });
    const { holder } = target(() => new Response(body(), { headers: { "content-type": "text/plain" } }));
    const read = vi.fn<ResponseWatcher["read"]>();
    const wantsBody = vi.fn((_url: string, prefix: string) => prefix.trimStart().startsWith("<"));
    observeResponses([{ wants: () => true, wantsBody, read }], holder);
    await holder.fetch("https://site.test/api/list");
    await flush();
    // JSON served as text: the watcher saw its start once, and the rest was never read.
    expect(wantsBody).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(pulled).toBeLessThan(10);
  });

  it("never lets a watcher or a failed request break the page's fetch", async () => {
    const { holder } = target(() => new Response("ok", { headers: { "content-type": "text/plain" } }));
    observeResponses([{ wants: () => { throw new Error("wants"); }, read: () => undefined },
      { wants: () => true, read: () => { throw new Error("read"); } }], holder);
    await expect(holder.fetch("https://site.test/a").then(response => response.text())).resolves.toBe("ok");
    const failing = { fetch: (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch, XMLHttpRequest: class {} as unknown as typeof XMLHttpRequest };
    observeResponses([recorder(() => true).watcher], failing);
    await expect(failing.fetch("https://site.test/a")).rejects.toThrow("offline");
    await flush();
  });

  it("leaves a page alone that made fetch read-only", () => {
    const frozen = Object.freeze({ fetch: (async () => new Response("")) as unknown as typeof fetch, XMLHttpRequest: class {} as unknown as typeof XMLHttpRequest });
    expect(() => observeResponses([recorder(() => true).watcher], frozen)).not.toThrow();
  });

  it("reads XHR responses as a document, as text and as JSON, once per load", () => {
    class FakeXhr extends EventTarget {
      responseType = "";
      responseText = "";
      response: unknown = null;
      responseXML: Document | null = null;
      responseURL = "";
      type = "text/plain";
      open(_method: string, _url: string): void { /* recorded by the patch */ }
      send(): void { /* the test fires load */ }
      getResponseHeader(name: string): string | null { return name === "content-type" ? this.type : null; }
    }
    const holder = { fetch: (async () => new Response("")) as unknown as typeof fetch, XMLHttpRequest: FakeXhr as unknown as typeof XMLHttpRequest };
    const { watcher, read } = recorder(() => true);
    observeResponses([watcher], holder);

    const text = new FakeXhr();
    text.open("GET", "/a.txt");
    text.send();
    text.responseText = "plain";
    text.dispatchEvent(new Event("load"));
    text.dispatchEvent(new Event("load"));
    const json = new FakeXhr();
    json.responseType = "json";
    json.open("GET", "https://site.test/a.json");
    json.send();
    json.response = { ASSETS: [] };
    json.dispatchEvent(new Event("load"));
    const xml = new FakeXhr();
    xml.responseType = "document";
    xml.open("GET", "https://site.test/vast.xml");
    xml.send();
    xml.responseXML = new DOMParser().parseFromString("<VAST/>", "text/xml");
    xml.dispatchEvent(new Event("load"));
    const binary = new FakeXhr();
    binary.responseType = "arraybuffer";
    binary.open("GET", "https://site.test/seg.ts");
    binary.send();
    binary.dispatchEvent(new Event("load"));

    expect(read.mock.calls.map(call => [call[0], typeof call[1] === "string" ? call[1] : "document"])).toEqual([
      [new URL("/a.txt", location.href).href, "plain"], ["https://site.test/a.json", "{\"ASSETS\":[]}"], ["https://site.test/vast.xml", "document"]]);
  });
});

describe("the resolver watcher", () => {
  it("delivers a site API response's media once, however often the page fetches it", async () => {
    const { holder } = target(() => new Response(tweetDetail, { headers: { "content-type": "application/json" } }));
    const emit = vi.fn();
    observeResponses([resolverWatcher(twitterResolver, emit)], holder);
    await holder.fetch(GRAPHQL_URL);
    await flush();
    const first = emit.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await holder.fetch(GRAPHQL_URL);
    await holder.fetch("https://x.com/home");
    await flush();
    expect(emit).toHaveBeenCalledTimes(first);
  });
});

describe("the ad watcher", () => {
  const VAST = `<VAST version="4.0"><Ad><InLine><Creatives><Creative><Linear><MediaFiles>
    <MediaFile type="video/webm"><![CDATA[https://ads.test/creative.webm]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`;

  it("posts the media files of a VAST response and requests nothing itself", async () => {
    const { holder, original } = target(() => new Response(VAST, { headers: { "content-type": "text/xml" } }));
    const post = vi.fn();
    observeResponses([adWatcher(post)], holder);
    await holder.fetch("https://site.test/ads/vast.xml");
    await flush();
    expect(post).toHaveBeenCalledWith(["https://ads.test/creative.webm"], "vast");
    expect(original).toHaveBeenCalledTimes(1);
  });

  it("reads VAST served as text, and ignores other XML and plain text", () => {
    const post = vi.fn();
    const watcher = adWatcher(post);
    expect(watcher.wants("https://site.test/tag", "text/plain; charset=utf-8")).toBe(true);
    watcher.read("https://site.test/tag", `\n  ${VAST}`);
    watcher.read("https://site.test/feed", "<rss><channel/></rss>");
    watcher.read("https://site.test/notes", "just text");
    expect(post).toHaveBeenCalledTimes(1);
    expect(watcher.wants("https://site.test/app.js", "text/javascript")).toBe(false);
    expect(watcher.wants("https://site.test/data", "application/json")).toBe(false);
    // Only markup and playlists are read on: JSON served as text is let go after its first part.
    expect(watcher.wantsBody?.("https://site.test/tag", "  <VAST version")).toBe(true);
    expect(watcher.wantsBody?.("https://site.test/live.m3u8", "#EXTM3U\n")).toBe(true);
    expect(watcher.wantsBody?.("https://site.test/api", `{"user":1}`)).toBe(false);
    expect(watcher.wants("https://site.test/x", "application/vnd.apple.mpegurl")).toBe(true);
    expect(watcher.wants("https://site.test/x", "application/vmap+xml")).toBe(true);
  });

  it("marks interstitial assets, and reads an asset list only after a playlist announced it", () => {
    const post = vi.fn();
    const watcher = adWatcher(post);
    const list = "https://ads.test/lists/assets.json";
    expect(watcher.wants(list, "application/json")).toBe(false);
    watcher.read(list, JSON.stringify({ ASSETS: [{ URI: "https://ads.test/early.m3u8" }] }));
    expect(post).not.toHaveBeenCalled();
    expect(watcher.wants("https://cdn.test/v/media.m3u8", "application/octet-stream")).toBe(true);
    watcher.read("https://cdn.test/v/media.m3u8", `#EXTM3U
#EXT-X-DATERANGE:ID="a",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:00:00Z",X-ASSET-URI="https://ads.test/ad.m3u8"
#EXT-X-DATERANGE:ID="b",CLASS="com.apple.hls.interstitial",START-DATE="2026-01-01T00:01:00Z",X-ASSET-LIST="${list}"
#EXTINF:4,\nseg.ts`);
    expect(post).toHaveBeenCalledWith(["https://ads.test/ad.m3u8"], "hls-interstitial");
    expect(watcher.wants(list, "application/json")).toBe(true);
    watcher.read(list, JSON.stringify({ ASSETS: [{ URI: "https://ads.test/listed.m3u8" }] }));
    expect(post).toHaveBeenLastCalledWith(["https://ads.test/listed.m3u8"], "hls-asset-list");
    watcher.read("https://cdn.test/v/plain.m3u8", "#EXTM3U\n#EXTINF:4,\nseg.ts");
    expect(post).toHaveBeenCalledTimes(2);
  });
});
