import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractCaptures, installInterceptor } from "../../../src/content/intercept";
import { twitterResolver } from "../../../src/content/sites/twitter";
import type { ResolvedMedia } from "../../../src/content/sites/types";

const tweetDetail = readFileSync(
  resolve(process.cwd(), "tests/unit/content/sites/fixtures/twitter-tweetdetail.json"),
  "utf-8",
);

const GRAPHQL_URL = "https://x.com/i/api/graphql/abc/TweetDetail";
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("extractCaptures", () => {
  it("returns resolver media for a matching URL", () => {
    expect(extractCaptures(twitterResolver, GRAPHQL_URL, tweetDetail).length).toBe(2);
  });

  it("returns nothing for a non-API URL even with a media body", () => {
    expect(extractCaptures(twitterResolver, "https://x.com/home", tweetDetail)).toEqual([]);
  });

  it("swallows resolver errors into an empty result", () => {
    const throwing = { ...twitterResolver, matchesApi: () => true, parse: () => { throw new Error("boom"); } };
    expect(extractCaptures(throwing, GRAPHQL_URL, tweetDetail)).toEqual([]);
  });
});

describe("installInterceptor — fetch", () => {
  it("delivers media from a matching fetch response, and nothing otherwise", async () => {
    const media: ResolvedMedia[] = [];
    const response = { clone: () => ({ text: async () => tweetDetail }) } as unknown as Response;
    const target = {
      fetch: (() => Promise.resolve(response)) as typeof fetch,
      XMLHttpRequest: class { open() {} send() {} } as unknown as typeof XMLHttpRequest,
    };

    installInterceptor(twitterResolver, m => media.push(m), target);

    await target.fetch("https://x.com/home");
    await flush();
    expect(media).toHaveLength(0);

    await target.fetch(GRAPHQL_URL);
    await flush();
    expect(media).toHaveLength(2);
    expect(media.some(m => m.url.includes("1280x720"))).toBe(true);
  });

  it("returns the page's original response object unchanged", async () => {
    const response = { clone: () => ({ text: async () => tweetDetail }) } as unknown as Response;
    const target = {
      fetch: (() => Promise.resolve(response)) as typeof fetch,
      XMLHttpRequest: class { open() {} send() {} } as unknown as typeof XMLHttpRequest,
    };
    installInterceptor(twitterResolver, () => undefined, target);
    expect(await target.fetch(GRAPHQL_URL)).toBe(response);
  });
});

describe("installInterceptor — XHR", () => {
  it("delivers media when a matching XHR load fires", () => {
    const media: ResolvedMedia[] = [];

    class FakeXHR {
      responseType: XMLHttpRequestResponseType = "";
      responseText = "";
      response: unknown = null;
      private listeners = new Map<string, Array<() => void>>();
      open(_method: string, _url: string): void {}
      send(): void {}
      addEventListener(type: string, cb: () => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
      }
      fire(type: string): void {
        for (const cb of this.listeners.get(type) ?? []) cb();
      }
    }

    const target = {
      fetch: (() => Promise.resolve(new Response())) as typeof fetch,
      XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest,
    };
    installInterceptor(twitterResolver, m => media.push(m), target);

    const xhr = new FakeXHR();
    xhr.responseText = tweetDetail;
    xhr.open("GET", GRAPHQL_URL);
    xhr.send();
    xhr.fire("load");

    expect(media).toHaveLength(2);
  });
});
