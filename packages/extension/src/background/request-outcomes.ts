// What the browser reported about savemedia's own requests: where each one
// connected, whether a redirect led to another host, and how it ended. This
// is the one set of request listeners for that. It only reads events: it
// makes no request, changes no setting and has no part in DNS, proxies or
// certificates. What it records explains a failure to the user
// (packages/core/src/errors/network-block.ts) and tells the capture code
// when a public name led into the user's own network.
//
// Nothing here is written to storage. An address leaves this module only
// inside a failure that is shown on this device; the diagnostic export
// carries the kind of address, never the address.
import { BROWSER_ERROR_CODE, type BrowserRequestDiagnostic } from "@savemedia/core";

type RequestEvents = Pick<typeof chrome.webRequest, "onBeforeRequest" | "onBeforeRedirect" | "onCompleted" | "onErrorOccurred">
  & Partial<Pick<typeof chrome.webRequest, "onResponseStarted">>;

/** How one request ended, or how far it has come. `status` is the last HTTP status the server sent. */
export interface RequestOutcome extends BrowserRequestDiagnostic {
  readonly at: number;
  readonly status: number | null;
}

/** One step of a request: the address asked for and the server address the browser reached for it. */
export interface RequestHop { readonly url: string; readonly ip: string }

/** One request savemedia is about to make, followed from the fetch call to the browser's last event for it. */
export interface WatchedRequest {
  /** The browser's events for this request are known to belong to it. */
  matched(): boolean;
  /** How the request ended. Pending until the browser ends it; a request the browser never reported stays pending. */
  readonly ended: Promise<RequestOutcome>;
  /** What is known once the server's answer began, or the request ended without one. */
  readonly answered: Promise<RequestOutcome>;
  /**
   * Where the request went, as far as reported: for each redirect hop and for the answer, the address
   * requested and the server address that answered it. They keep arriving while the answer is read.
   */
  readonly hops: readonly RequestHop[];
  /** Stop waiting for a request to match. A matched request is followed to its end. */
  release(): void;
}

export interface RequestOutcomes {
  /** Follow the next request for this address. Two watches of one address at a time cannot be told apart: neither is matched. */
  watch(url: string): WatchedRequest;
  /**
   * The latest finished request to this host since `since` (ms since the epoch): one a server answered
   * ("answer", with that status when one is given) or one the browser failed ("error"). A request savemedia
   * cancelled itself is neither.
   */
  latestForHost(host: string, since: number, want: "answer" | "error", status?: number | null): RequestOutcome | null;
}

interface Tracked {
  readonly host: string;
  /** The host of the address the request is at now, after its redirects. */
  current: string;
  ip: string | null;
  status: number | null;
  redirect: BrowserRequestDiagnostic["redirect"];
  answered: boolean;
  watch: Watch | null;
}

interface Watch extends WatchedRequest {
  requestId: string | null;
  readonly hops: RequestHop[];
  readonly settle: { readonly ended: (outcome: RequestOutcome) => void; readonly answered: (outcome: RequestOutcome) => void };
}

const MAX_OUTCOMES = 256;
const MAX_OPEN_REQUESTS = 1024;
const OUTCOME_LIFETIME_MS = 10 * 60_000;
const ABORTED = new Set(["net::ERR_ABORTED", "NS_BINDING_ABORTED"]);

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

function hostnameOf(host: string): string {
  try { return new URL(`http://${host}`).hostname; } catch { return host; }
}

function withoutHash(url: string): string {
  try {
    const target = new URL(url);
    target.hash = "";
    return target.href;
  } catch { return url; }
}

const NONE: RequestOutcomes = {
  watch: () => ({ matched: () => false, ended: new Promise<RequestOutcome>(() => undefined), answered: new Promise<RequestOutcome>(() => undefined),
    hops: [], release: () => undefined }),
  latestForHost: () => null,
};

export function createRequestOutcomes(events: RequestEvents | undefined, extensionOrigin: string, now: () => number = Date.now): RequestOutcomes {
  if (!events?.onBeforeRequest) return NONE;

  const waiting = new Map<string, Set<Watch>>();
  /** savemedia's own requests the browser has not ended yet, by request id. */
  const requests = new Map<string, Tracked>();
  const finished: RequestOutcome[] = [];
  // Requests the extension makes outside a tab: the service worker's checks and the engine document's transfers.
  const filter = { urls: ["http://*/*", "https://*/*"], tabId: -1 };

  function own(details: { initiator?: string | undefined; originUrl?: string | undefined }): boolean {
    if (details.initiator !== undefined) return details.initiator === extensionOrigin;
    // Firefox reports the requesting document's address instead of an initiator.
    return details.originUrl === extensionOrigin || details.originUrl?.startsWith(`${extensionOrigin}/`) === true;
  }

  function snapshot(request: Tracked, code: string | null): RequestOutcome {
    return { host: request.host, code, ip: request.ip, finalHost: request.current !== request.host ? request.current : null,
      redirect: request.redirect, status: request.status, at: now() };
  }

  /** `url` is the address this event is about: the hop that redirected, or the one that answered. */
  function noteAddress(request: Tracked, ip: string | undefined, url: string): void {
    if (!ip) return;
    request.ip = ip;
    const hops = request.watch?.hops;
    if (hops && !hops.some(hop => hop.ip === ip && hostOf(hop.url) === hostOf(url))) hops.push({ url, ip });
  }

  function end(requestId: string, code: string | null): void {
    const request = requests.get(requestId);
    if (!request) return;
    requests.delete(requestId);
    const outcome = snapshot(request, code);
    // What is too old to explain anything is dropped, and the log never holds more than its bound.
    while (finished.length && finished[0]!.at < outcome.at - OUTCOME_LIFETIME_MS) finished.shift();
    finished.push(outcome);
    if (finished.length > MAX_OUTCOMES) finished.splice(0, finished.length - MAX_OUTCOMES);
    request.watch?.settle.answered(outcome);
    request.watch?.settle.ended(outcome);
  }

  events.onBeforeRequest.addListener(details => {
    if (!own(details as never) || details.method !== "GET" || requests.has(details.requestId)) return;
    const host = hostOf(details.url);
    const request: Tracked = { host, current: host, ip: null, status: null, redirect: null, answered: false, watch: null };
    // A request whose end the browser never reports must not stay forever.
    if (requests.size >= MAX_OPEN_REQUESTS) requests.delete(requests.keys().next().value!);
    requests.set(details.requestId, request);
    const key = withoutHash(details.url);
    const group = waiting.get(key);
    if (!group) return;
    // A redirect keeps the same request id. Two watches of one address cannot be told apart, so neither is matched.
    waiting.delete(key);
    if (group.size !== 1) return;
    const watch = group.values().next().value!;
    watch.requestId = details.requestId;
    request.watch = watch;
  }, filter);

  events.onBeforeRedirect.addListener(details => {
    const request = requests.get(details.requestId);
    if (!request) return;
    noteAddress(request, details.ip, details.url);
    request.status = details.statusCode ?? request.status;
    const to = hostOf(details.redirectUrl);
    // A redirect to something that is not a web address ends what can be observed.
    if (!/^https?:\/\//i.test(details.redirectUrl)) { end(details.requestId, null); return; }
    if (!request.redirect && to && hostnameOf(to) !== hostnameOf(request.current)) {
      request.redirect = { toHost: to, status: details.statusCode ?? 0, fromIp: details.ip ?? null };
    }
    if (to) request.current = to;
  }, filter);

  events.onResponseStarted?.addListener(details => {
    const request = requests.get(details.requestId);
    if (!request) return;
    noteAddress(request, details.ip, details.url);
    request.status = details.statusCode ?? request.status;
    request.current = hostOf(details.url) || request.current;
    request.answered = true;
    request.watch?.settle.answered(snapshot(request, null));
  }, filter);

  events.onCompleted.addListener(details => {
    const request = requests.get(details.requestId);
    if (!request) return;
    noteAddress(request, details.ip, details.url);
    request.status = details.statusCode ?? request.status;
    end(details.requestId, null);
  }, filter);

  events.onErrorOccurred.addListener(details => {
    const request = requests.get(details.requestId);
    if (!request) return;
    noteAddress(request, details.ip, details.url);
    // Only code-shaped text is kept: browsers change their error strings, and prose can carry an address.
    const code = BROWSER_ERROR_CODE.test(details.error) ? details.error : null;
    // A request that was answered and then cancelled was cancelled by savemedia: the server's answer stands.
    end(details.requestId, request.answered && code !== null && ABORTED.has(code) ? null : code);
  }, filter);

  return {
    watch(url) {
      const key = withoutHash(url);
      let ended!: (outcome: RequestOutcome) => void;
      let answered!: (outcome: RequestOutcome) => void;
      const watch: Watch = {
        requestId: null,
        hops: [],
        ended: new Promise<RequestOutcome>(resolve => { ended = resolve; }),
        answered: new Promise<RequestOutcome>(resolve => { answered = resolve; }),
        settle: { ended: outcome => ended(outcome), answered: outcome => answered(outcome) },
        matched: () => watch.requestId !== null,
        release() {
          const group = waiting.get(key);
          group?.delete(watch);
          if (group?.size === 0 && waiting.get(key) === group) waiting.delete(key);
        },
      };
      const group = waiting.get(key) ?? new Set<Watch>();
      waiting.set(key, group);
      group.add(watch);
      return watch;
    },

    latestForHost(host, since, want, status = null) {
      const name = hostnameOf(host);
      const oldest = Math.max(since, now() - OUTCOME_LIFETIME_MS);
      const matches = (outcome: RequestOutcome): boolean => {
        if (outcome.at < oldest) return false;
        if (![outcome.host, outcome.finalHost ?? ""].some(candidate => candidate === host || hostnameOf(candidate) === name)) return false;
        if (want === "error") return outcome.code !== null && !ABORTED.has(outcome.code);
        return outcome.code === null && outcome.status !== null && (status === null || outcome.status === status);
      };
      for (let index = finished.length - 1; index >= 0; index--) if (matches(finished[index]!)) return finished[index]!;
      return null;
    },
  };
}

/** The part of an outcome a failure carries. */
export function diagnosticOf(outcome: RequestOutcome): BrowserRequestDiagnostic {
  return { host: outcome.host, code: outcome.code, ip: outcome.ip, finalHost: outcome.finalHost, redirect: outcome.redirect };
}
