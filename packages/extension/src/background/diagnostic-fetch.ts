import type { BrowserRequestDiagnostic } from "@savemedia/core";
import { BrowserFetchError } from "../engine/net/transfer-error";
import { diagnosticOf, type RequestHop, type RequestOutcome, type RequestOutcomes, type WatchedRequest } from "./request-outcomes";

export type DiagnosticFetch = ((url: string, init: RequestInit) => Promise<Response>) & {
  /**
   * Where the request behind a response went: for each redirect hop and for
   * the answer, the address requested and the server address the browser
   * reported, as far as they are known now. The browser reports them while
   * the response arrives, so a caller asks after it has read the body.
   */
  serverHops(response: object): readonly RequestHop[];
  /**
   * What the browser reported about the request behind a response: where it
   * connected and whether a redirect led to another host. Null for a
   * response whose request could not be told apart from another, or when the
   * caller's signal ends the wait for the browser's report.
   */
  outcomeOf(response: object, signal?: AbortSignal | null): Promise<RequestOutcome | null>;
};

/**
 * Fetch exposes a generic TypeError for many browser failures. This follows
 * the extension's own checks through the browser's request events and
 * attaches the browser's account to that error. A certificate error on the
 * matched request also stops retries to that address. The browser remains
 * responsible for TLS on every connection.
 */
export function createDiagnosticFetch(
  outcomes: RequestOutcomes | undefined,
  fetchMedia: typeof fetch = (input, init) => fetch(input, init),
): DiagnosticFetch {
  if (!outcomes) {
    return Object.assign((url: string, init: RequestInit) => fetchMedia(url, init), { serverHops: () => [], outcomeOf: async () => null });
  }
  const served = new WeakMap<object, WatchedRequest>();

  return Object.assign(async (url: string, init: RequestInit) => {
    const watch = outcomes.watch(url);
    try {
      const response = await fetchMedia(url, init);
      served.set(response, watch);
      return response;
    } catch (error) {
      // The browser can reject fetch before it reports how the request ended.
      if (error instanceof TypeError && watch.matched() && !init.signal?.aborted) {
        const outcome = await until(watch.ended, init.signal);
        const diagnostic: BrowserRequestDiagnostic | null = outcome?.code ? diagnosticOf(outcome) : null;
        if (diagnostic) throw new BrowserFetchError(diagnostic);
      }
      throw error;
    } finally {
      // A matched request keeps its id until the browser ends it, so a redirect
      // cannot be taken for another check of its destination.
      watch.release();
    }
  }, {
    serverHops: (response: object): readonly RequestHop[] => served.get(response)?.hops ?? [],
    outcomeOf: async (response: object, signal?: AbortSignal | null): Promise<RequestOutcome | null> => {
      const watch = served.get(response);
      return watch?.matched() ? until(watch.answered, signal) : null;
    },
  });
}

/**
 * The browser's own account of a request arrives with one of its events,
 * which can come after fetch has already settled. No clock ends the wait:
 * the event does, or the caller's signal.
 */
function until<T>(outcome: Promise<T>, signal: AbortSignal | null | undefined): Promise<T | null> {
  if (!signal) return outcome;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const aborted = (): void => resolve(null);
    signal.addEventListener("abort", aborted, { once: true });
    void outcome.then(value => {
      signal.removeEventListener("abort", aborted);
      resolve(value);
    });
  });
}
