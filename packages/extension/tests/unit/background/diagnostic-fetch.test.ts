import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticFetch } from "../../../src/background/diagnostic-fetch";
import { createRequestOutcomes } from "../../../src/background/request-outcomes";
import { BrowserFetchError } from "../../../src/engine/net/transfer-error";

type Listener = (details: Record<string, unknown>) => void;
const ORIGIN = "chrome-extension://ext-id";

function events() {
  const listeners: Record<string, Listener> = {};
  const event = (name: string) => ({ addListener: (listener: Listener) => { listeners[name] = listener; } });
  const api = { onBeforeRequest: event("onBeforeRequest"), onBeforeRedirect: event("onBeforeRedirect"), onCompleted: event("onCompleted"),
    onErrorOccurred: event("onErrorOccurred"), onResponseStarted: event("onResponseStarted") } as never;
  return { outcomes: createRequestOutcomes(api, ORIGIN), fire: (name: string, details: Record<string, unknown>) => listeners[name]!(details) };
}

const URL_ = "https://media.example/clip.mp4";
const request = (id = "1", url = URL_) => ({ requestId: id, url, method: "GET", initiator: ORIGIN });

// Fake timers: a wait that a clock could end would end here when the clock is moved.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the browser's own account of a failed request", () => {
  it("is attached to the error however long after the rejection the browser reports it", async () => {
    const { outcomes, fire } = events();
    let reject!: (error: unknown) => void;
    const probe = createDiagnosticFetch(outcomes, () => new Promise((_resolve, fail) => { reject = fail; }));
    const result = probe(URL_, {}).then(() => "resolved", error => error as unknown);
    fire("onBeforeRequest", request());
    reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(500);
    // Half a second later nothing has decided anything.
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    fire("onErrorOccurred", { requestId: "1", url: URL_, error: "net::ERR_CERT_AUTHORITY_INVALID", ip: "192.168.1.1" });
    const error = await result;
    expect(error).toBeInstanceOf(BrowserFetchError);
    expect((error as BrowserFetchError).diagnostic).toEqual({ code: "net::ERR_CERT_AUTHORITY_INVALID", host: "media.example", ip: "192.168.1.1",
      finalHost: null, redirect: null });
  });

  it("carries the redirect that led to the failing host", async () => {
    const { outcomes, fire } = events();
    let reject!: (error: unknown) => void;
    const probe = createDiagnosticFetch(outcomes, () => new Promise((_resolve, fail) => { reject = fail; }));
    const result = probe(URL_, {}).catch(error => error as unknown);
    fire("onBeforeRequest", request());
    fire("onBeforeRedirect", { requestId: "1", url: URL_, redirectUrl: "https://filter.example:8443/blocked", statusCode: 302, ip: "203.0.113.9" });
    reject(new TypeError("Failed to fetch"));
    fire("onErrorOccurred", { requestId: "1", url: "https://filter.example:8443/blocked", error: "net::ERR_CERT_AUTHORITY_INVALID" });
    expect(((await result) as BrowserFetchError).diagnostic).toEqual({ code: "net::ERR_CERT_AUTHORITY_INVALID", host: "media.example", ip: "203.0.113.9",
      finalHost: "filter.example:8443", redirect: { toHost: "filter.example:8443", status: 302, fromIp: "203.0.113.9" } });
  });

  it("ends the wait when the caller gives up", async () => {
    const { outcomes, fire } = events();
    let reject!: (error: unknown) => void;
    const controller = new AbortController();
    const probe = createDiagnosticFetch(outcomes, () => new Promise((_resolve, fail) => { reject = fail; }));
    const result = probe(URL_, { signal: controller.signal }).then(() => "resolved", error => error as unknown);
    fire("onBeforeRequest", request());
    const failure = new TypeError("Failed to fetch");
    reject(failure);
    await vi.advanceTimersByTimeAsync(60_000);
    controller.abort();
    expect(await result).toBe(failure);
  });

  it("rethrows at once what the browser never saw as a request, and what two probes of one address make ambiguous", async () => {
    const { outcomes, fire } = events();
    const failure = new TypeError("Failed to fetch");
    const unseen = createDiagnosticFetch(outcomes, async () => { throw failure; });
    await expect(unseen(URL_, {})).rejects.toBe(failure);

    const rejects: ((error: unknown) => void)[] = [];
    const twice = createDiagnosticFetch(outcomes, () => new Promise((_resolve, fail) => { rejects.push(fail); }));
    const both = [twice(URL_, {}), twice(URL_, {})].map(result => result.then(() => "resolved", error => error as unknown));
    fire("onBeforeRequest", request("7"));
    for (const fail of rejects) fail(failure);
    expect(await Promise.all(both)).toEqual([failure, failure]);
  });

  it("keeps the original error when the browser ended the request without a code", async () => {
    const { outcomes, fire } = events();
    const failure = new TypeError("Failed to fetch");
    let reject!: (error: unknown) => void;
    const probe = createDiagnosticFetch(outcomes, () => new Promise((_resolve, fail) => { reject = fail; }));
    const result = probe(URL_, {}).catch(error => error as unknown);
    fire("onBeforeRequest", request());
    reject(failure);
    fire("onErrorOccurred", { requestId: "1", url: URL_, error: "some prose about the failure" });
    expect(await result).toBe(failure);
  });

  it("leaves a non-network error and a completed request alone", async () => {
    const { outcomes, fire } = events();
    const other = new Error("not a network failure");
    const probe = createDiagnosticFetch(outcomes, async () => { throw other; });
    const result = probe(URL_, {}).catch(error => error as unknown);
    fire("onBeforeRequest", request());
    expect(await result).toBe(other);

    const response = { status: 200 };
    const ok = createDiagnosticFetch(outcomes, async () => response as never);
    const pending = ok(URL_, {});
    fire("onBeforeRequest", request("2"));
    fire("onResponseStarted", { requestId: "2", url: URL_, ip: "93.184.216.34", statusCode: 200 });
    expect(await pending).toBe(response);
    expect(ok.serverHops(response)).toEqual([{ url: URL_, ip: "93.184.216.34" }]);
  });
});

describe("what the browser reported about a response", () => {
  it("is known once the answer began, also when the event arrives after the response", async () => {
    const { outcomes, fire } = events();
    const response = { status: 200 };
    const probe = createDiagnosticFetch(outcomes, async () => response as never);
    const pending = probe(URL_, {});
    fire("onBeforeRequest", request());
    expect(await pending).toBe(response);
    const outcome = probe.outcomeOf(response);
    fire("onBeforeRedirect", { requestId: "1", url: URL_, redirectUrl: "https://filter.example/blocked", statusCode: 302, ip: "10.0.0.1" });
    fire("onResponseStarted", { requestId: "1", url: "https://filter.example/blocked", ip: "10.0.0.2", statusCode: 200 });
    expect(await outcome).toMatchObject({ host: "media.example", code: null, ip: "10.0.0.2", finalHost: "filter.example", status: 200,
      redirect: { toHost: "filter.example", status: 302, fromIp: "10.0.0.1" } });
  });

  it("is null for a response whose request could not be told apart, for an unknown response, and when the caller gives up", async () => {
    const { outcomes, fire } = events();
    const response = { status: 200 };
    const probe = createDiagnosticFetch(outcomes, async () => response as never);
    expect(await probe(URL_, {})).toBe(response);
    expect(await probe.outcomeOf(response)).toBeNull();
    expect(await probe.outcomeOf({})).toBeNull();

    const matched = { status: 200 };
    const second = createDiagnosticFetch(outcomes, async () => matched as never);
    const pending = second(URL_, {});
    fire("onBeforeRequest", request("5"));
    await pending;
    const controller = new AbortController();
    const waiting = second.outcomeOf(matched, controller.signal);
    controller.abort();
    expect(await waiting).toBeNull();
  });

  it("without request events it fetches as it is and reports nothing", async () => {
    const response = { status: 200 };
    const plain = createDiagnosticFetch(undefined, async () => response as never);
    expect(await plain(URL_, {})).toBe(response);
    expect(plain.serverHops(response)).toEqual([]);
    expect(await plain.outcomeOf(response)).toBeNull();
  });
});
