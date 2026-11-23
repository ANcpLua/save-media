import { describe, expect, it } from "vitest";
import { createRequestOutcomes, diagnosticOf } from "../../../src/background/request-outcomes";

type Listener = (details: Record<string, unknown>) => void;
const ORIGIN = "chrome-extension://ext-id";
const URL_ = "https://media.public-site.net/v/clip.mp4?token=secret";

function events(withResponseStarted = true) {
  const listeners: Record<string, Listener> = {};
  const filters: unknown[] = [];
  const event = (name: string) => ({ addListener: (listener: Listener, filter: unknown) => { listeners[name] = listener; filters.push(filter); } });
  const api = { onBeforeRequest: event("onBeforeRequest"), onBeforeRedirect: event("onBeforeRedirect"), onCompleted: event("onCompleted"),
    onErrorOccurred: event("onErrorOccurred"), ...(withResponseStarted ? { onResponseStarted: event("onResponseStarted") } : {}) };
  return { api: api as never, filters, fire: (name: string, details: Record<string, unknown>) => listeners[name]!(details) };
}

const request = (id = "1", url = URL_, extra: Record<string, unknown> = {}) => ({ requestId: id, url, method: "GET", initiator: ORIGIN, ...extra });

function setup(now = () => 1_000) {
  const browser = events();
  return { ...browser, outcomes: createRequestOutcomes(browser.api, ORIGIN, now) };
}

describe("what the browser reports about savemedia's own requests", () => {
  it("listens only to requests made outside a tab, and only reads them", () => {
    const { filters } = setup();
    expect(filters).toHaveLength(5);
    for (const filter of filters) expect(filter).toEqual({ urls: ["http://*/*", "https://*/*"], tabId: -1 });
  });

  it("records the server address and status when the answer begins, and ends with the browser's last event", async () => {
    const { outcomes, fire } = setup();
    const watch = outcomes.watch(URL_);
    expect(watch.matched()).toBe(false);
    fire("onBeforeRequest", request());
    expect(watch.matched()).toBe(true);
    fire("onResponseStarted", { requestId: "1", url: URL_, ip: "203.0.113.9", statusCode: 200 });
    expect(await watch.answered).toEqual({ host: "media.public-site.net", code: null, ip: "203.0.113.9", finalHost: null, redirect: null, status: 200, at: 1_000 });
    expect(watch.hops).toEqual([{ url: URL_, ip: "203.0.113.9" }]);
    fire("onCompleted", { requestId: "1", url: URL_, ip: "203.0.113.9", statusCode: 200 });
    expect(await watch.ended).toMatchObject({ code: null, status: 200 });
  });

  it("records the first redirect to another host, with its status and the address that sent it", async () => {
    const { outcomes, fire } = setup();
    const watch = outcomes.watch(URL_);
    fire("onBeforeRequest", request());
    // A redirect on the same host is not a redirect elsewhere.
    fire("onBeforeRedirect", { requestId: "1", url: URL_, redirectUrl: "https://media.public-site.net/v2/clip.mp4", statusCode: 301, ip: "192.168.1.1" });
    fire("onBeforeRedirect", { requestId: "1", url: URL_, redirectUrl: "https://filter.public-site.net:8443/blocked", statusCode: 302, ip: "192.168.1.1" });
    fire("onBeforeRedirect", { requestId: "1", url: URL_, redirectUrl: "https://portal.public-site.net/", statusCode: 307, ip: "192.168.1.2" });
    fire("onResponseStarted", { requestId: "1", url: "https://portal.public-site.net/", ip: "192.168.1.3", statusCode: 200 });
    fire("onCompleted", { requestId: "1", url: "https://portal.public-site.net/", ip: "192.168.1.3", statusCode: 200 });
    const outcome = await watch.ended;
    expect(diagnosticOf(outcome)).toEqual({ host: "media.public-site.net", code: null, ip: "192.168.1.3", finalHost: "portal.public-site.net",
      redirect: { toHost: "filter.public-site.net:8443", status: 302, fromIp: "192.168.1.1" } });
    // Each step with the address it asked for: which server answered from where. The same server and address is one step.
    expect(watch.hops).toEqual([{ url: URL_, ip: "192.168.1.1" }, { url: URL_, ip: "192.168.1.2" },
      { url: "https://portal.public-site.net/", ip: "192.168.1.3" }]);
  });

  it("keeps the browser's error code and the address it tried, and nothing that is not code-shaped", async () => {
    const { outcomes, fire } = setup();
    const failed = outcomes.watch(URL_);
    fire("onBeforeRequest", request());
    fire("onErrorOccurred", { requestId: "1", url: URL_, error: "net::ERR_CONNECTION_REFUSED", ip: "10.0.0.1" });
    expect(await failed.ended).toMatchObject({ code: "net::ERR_CONNECTION_REFUSED", ip: "10.0.0.1", status: null });

    const prose = outcomes.watch(URL_);
    fire("onBeforeRequest", request("2"));
    fire("onErrorOccurred", { requestId: "2", url: URL_, error: `Failed to load ${URL_}` });
    expect(await prose.ended).toMatchObject({ code: null });
    expect(JSON.stringify(await prose.ended)).not.toContain("secret");
  });

  it("treats a cancel after the answer began as savemedia's own, and keeps the server's answer", async () => {
    const { outcomes, fire } = setup();
    const watch = outcomes.watch(URL_);
    fire("onBeforeRequest", request());
    fire("onResponseStarted", { requestId: "1", url: URL_, ip: "127.0.0.1", statusCode: 200 });
    fire("onErrorOccurred", { requestId: "1", url: URL_, error: "net::ERR_ABORTED", ip: "127.0.0.1" });
    expect(await watch.ended).toMatchObject({ code: null, ip: "127.0.0.1", status: 200 });
    // A cancel before any answer stays a cancel.
    const early = outcomes.watch(URL_);
    fire("onBeforeRequest", request("2"));
    fire("onErrorOccurred", { requestId: "2", url: URL_, error: "net::ERR_ABORTED" });
    expect(await early.ended).toMatchObject({ code: "net::ERR_ABORTED" });
  });

  it("ignores requests of pages, of other extensions and with other methods; knows this extension by its page address where no initiator is reported", async () => {
    const { outcomes, fire } = setup();
    const watch = outcomes.watch(URL_);
    fire("onBeforeRequest", request("1", URL_, { initiator: "https://news.example" }));
    fire("onBeforeRequest", request("2", URL_, { initiator: "chrome-extension://other" }));
    fire("onBeforeRequest", request("3", URL_, { method: "POST" }));
    expect(watch.matched()).toBe(false);
    fire("onErrorOccurred", { requestId: "1", url: URL_, error: "net::ERR_FAILED" });
    expect(outcomes.latestForHost("media.public-site.net", 0, "error")).toBeNull();
    // Firefox: no initiator, the requesting document's address instead.
    const firefox = setup();
    const own = createRequestOutcomes(firefox.api, "moz-extension://abc");
    const seen = own.watch(URL_);
    firefox.fire("onBeforeRequest", { requestId: "9", url: URL_, method: "GET", originUrl: "moz-extension://abc/_generated_background_page.html" });
    expect(seen.matched()).toBe(true);
    firefox.fire("onBeforeRequest", { requestId: "10", url: URL_, method: "GET", originUrl: "https://news.example/page" });
    firefox.fire("onErrorOccurred", { requestId: "10", url: URL_, error: "NS_ERROR_UNKNOWN_HOST" });
    expect(own.latestForHost("media.public-site.net", 0, "error")).toBeNull();
  });

  it("matches neither of two watches of one address, and matches again once the address is watched alone", () => {
    const { outcomes, fire } = setup();
    const first = outcomes.watch(URL_);
    const second = outcomes.watch(`${URL_}#t=10`);
    fire("onBeforeRequest", request("1"));
    expect([first.matched(), second.matched()]).toEqual([false, false]);
    first.release();
    second.release();
    const alone = outcomes.watch(URL_);
    fire("onBeforeRequest", request("2"));
    expect(alone.matched()).toBe(true);
    // A watch that was released before any request is matched to none.
    const released = outcomes.watch("https://media.public-site.net/other.mp4");
    released.release();
    fire("onBeforeRequest", request("3", "https://media.public-site.net/other.mp4"));
    expect(released.matched()).toBe(false);
  });

  it("works without the response-started event: the end of the request settles both", async () => {
    const browser = events(false);
    const outcomes = createRequestOutcomes(browser.api, ORIGIN, () => 5);
    const watch = outcomes.watch(URL_);
    browser.fire("onBeforeRequest", request());
    browser.fire("onCompleted", { requestId: "1", url: URL_, ip: "203.0.113.9", statusCode: 206 });
    expect(await watch.answered).toMatchObject({ ip: "203.0.113.9", status: 206 });
  });

  it("without request events it watches nothing and knows nothing", () => {
    const none = createRequestOutcomes(undefined, ORIGIN);
    expect(none.watch(URL_).matched()).toBe(false);
    expect(none.latestForHost("media.public-site.net", 0, "answer")).toBeNull();
  });
});

describe("the latest request to a host", () => {
  function finished(now: () => number) {
    const { outcomes, fire } = setup(now);
    let id = 0;
    return {
      outcomes,
      answer(url: string, status: number, ip = "203.0.113.9") {
        const requestId = String(++id);
        fire("onBeforeRequest", request(requestId, url));
        fire("onResponseStarted", { requestId, url, ip, statusCode: status });
        fire("onCompleted", { requestId, url, ip, statusCode: status });
      },
      fail(url: string, error: string, ip?: string) {
        const requestId = String(++id);
        fire("onBeforeRequest", request(requestId, url));
        fire("onErrorOccurred", { requestId, url, error, ...(ip ? { ip } : {}) });
      },
    };
  }

  it("tells an answered request from a failed one, skips savemedia's own cancels, and respects the start time", () => {
    let clock = 100;
    const log = finished(() => clock);
    log.fail("https://cdn.public-site.net/a.ts", "net::ERR_CERT_AUTHORITY_INVALID");
    clock = 200;
    log.answer("https://cdn.public-site.net/b.ts", 403, "10.0.0.1");
    clock = 300;
    log.fail("https://cdn.public-site.net/c.ts", "net::ERR_ABORTED");
    clock = 400;
    expect(log.outcomes.latestForHost("cdn.public-site.net", 0, "error")).toMatchObject({ code: "net::ERR_CERT_AUTHORITY_INVALID", at: 100 });
    expect(log.outcomes.latestForHost("cdn.public-site.net", 0, "answer")).toMatchObject({ status: 403, ip: "10.0.0.1", at: 200 });
    expect(log.outcomes.latestForHost("cdn.public-site.net", 0, "answer", 403)).toMatchObject({ status: 403 });
    expect(log.outcomes.latestForHost("cdn.public-site.net", 0, "answer", 404)).toBeNull();
    expect(log.outcomes.latestForHost("cdn.public-site.net", 150, "error")).toBeNull();
    expect(log.outcomes.latestForHost("other.public-site.net", 0, "error")).toBeNull();
  });

  it("finds a request by the host that answered after a redirect, with or without a port in the name", () => {
    const { outcomes, fire } = setup();
    fire("onBeforeRequest", request("1", "https://media.public-site.net:8443/clip.mp4"));
    fire("onBeforeRedirect", { requestId: "1", url: "https://media.public-site.net:8443/clip.mp4", redirectUrl: "https://filter.public-site.net/b", statusCode: 302 });
    fire("onResponseStarted", { requestId: "1", url: "https://filter.public-site.net/b", ip: "192.168.1.1", statusCode: 200 });
    fire("onCompleted", { requestId: "1", url: "https://filter.public-site.net/b", statusCode: 200 });
    expect(outcomes.latestForHost("media.public-site.net:8443", 0, "answer")).toMatchObject({ finalHost: "filter.public-site.net" });
    expect(outcomes.latestForHost("media.public-site.net", 0, "answer")).not.toBeNull();
    expect(outcomes.latestForHost("filter.public-site.net", 0, "answer")).not.toBeNull();
  });

  it("forgets what is older than ten minutes and keeps at most 256 finished requests", () => {
    let clock = 0;
    const log = finished(() => clock);
    log.fail("https://old.public-site.net/a", "net::ERR_CONNECTION_RESET");
    clock = 10 * 60_000 + 1;
    expect(log.outcomes.latestForHost("old.public-site.net", 0, "error")).toBeNull();
    for (let index = 0; index < 256; index++) log.fail(`https://new.public-site.net/${index}`, "net::ERR_CONNECTION_RESET");
    log.fail("https://first.public-site.net/a", "net::ERR_CONNECTION_RESET");
    expect(log.outcomes.latestForHost("first.public-site.net", 0, "error")).not.toBeNull();
    for (let index = 0; index < 256; index++) log.fail(`https://new.public-site.net/again-${index}`, "net::ERR_CONNECTION_RESET");
    expect(log.outcomes.latestForHost("first.public-site.net", 0, "error")).toBeNull();
  });
});
