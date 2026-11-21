import type { BrowserRequestDiagnostic } from "@savemedia/core";
import { BrowserFetchError } from "../engine/net/error-classification";

type RequestEvents = Pick<typeof chrome.webRequest, "onBeforeRequest" | "onBeforeRedirect" | "onCompleted" | "onErrorOccurred">;

interface PendingProbe {
  requestId?: string;
  readonly outcome: Promise<BrowserRequestDiagnostic | undefined>;
  readonly finish: (diagnostic?: BrowserRequestDiagnostic) => void;
}

/**
 * Fetch exposes a generic TypeError for many browser failures. Observe the
 * extension's own probes and attach the browser's diagnostic to that error.
 * It is display-only. It never governs retries, routing or verification.
 */
export function createDiagnosticFetch(
  events: RequestEvents | undefined,
  extensionOrigin: string,
  fetchMedia: typeof fetch = (input, init) => fetch(input, init),
): (url: string, init: RequestInit) => Promise<Response> {
  if (!events?.onBeforeRequest) return (url, init) => fetchMedia(url, init);

  const waiting = new Map<string, Set<PendingProbe>>();
  const requests = new Map<string, PendingProbe | null>();
  const filter = { urls: ["http://*/*", "https://*/*"], tabId: -1 };

  events.onBeforeRequest.addListener(details => {
    if (details.initiator !== extensionOrigin || details.method !== "GET" || requests.has(details.requestId)) return;
    requests.set(details.requestId, null);
    const group = waiting.get(details.url);
    if (!group) return;

    // A redirect keeps the same request ID. Concurrent probes for the
    // same URL are ambiguous, so let their errors retain the generic message.
    waiting.delete(details.url);
    if (group.size !== 1) return;
    const probe = group.values().next().value!;
    probe.requestId = details.requestId;
    requests.set(details.requestId, probe);
  }, filter);

  function finish(id: string, diagnostic?: BrowserRequestDiagnostic): void {
    const probe = requests.get(id);
    requests.delete(id);
    probe?.finish(diagnostic);
  }

  events.onBeforeRedirect.addListener(details => {
    if (!/^https?:\/\//.test(details.redirectUrl)) finish(details.requestId);
  }, filter);
  events.onCompleted.addListener(details => finish(details.requestId), filter);
  events.onErrorOccurred.addListener(details => {
    if (!requests.get(details.requestId)) {
      requests.delete(details.requestId);
      return;
    }
    // Keep only code-shaped diagnostics and the host. Browser versions
    // can change their error strings, and a URL can carry private tokens.
    const diagnostic = /^(?:net::ERR_|NS_ERROR_)[A-Z0-9_]{1,80}$/.test(details.error)
      ? { code: details.error, host: new URL(details.url).host }
      : undefined;
    finish(details.requestId, diagnostic);
  }, filter);

  return async (url, init) => {
    const target = new URL(url);
    target.hash = "";
    const key = target.href;
    let resolve!: PendingProbe["finish"];
    const outcome = new Promise<BrowserRequestDiagnostic | undefined>(done => { resolve = done; });
    const probe: PendingProbe = { outcome, finish: resolve };
    const group = waiting.get(key) ?? new Set<PendingProbe>();
    waiting.set(key, group);
    group.add(probe);

    try {
      return await fetchMedia(url, init);
    } catch (error) {
      // Chromium can reject fetch before delivering onErrorOccurred.
      if (error instanceof TypeError && probe.requestId && !init.signal?.aborted) {
        const diagnostic = await waitForDiagnostic(probe.outcome);
        if (diagnostic) throw new BrowserFetchError(diagnostic);
      }
      throw error;
    } finally {
      group.delete(probe);
      if (group.size === 0 && waiting.get(key) === group) waiting.delete(key);
      // Keep the ID until the browser ends the request so a redirect
      // cannot be associated with an unrelated probe for its destination.
      if (probe.requestId && requests.get(probe.requestId) === probe) requests.set(probe.requestId, null);
    }
  };
}

async function waitForDiagnostic(outcome: PendingProbe["outcome"]): Promise<BrowserRequestDiagnostic | undefined> {
  let cancelTimeout: (() => void) | undefined;
  try {
    return await Promise.race([
      outcome,
      new Promise<undefined>(resolve => {
        const timer = setTimeout(() => resolve(undefined), 200);
        cancelTimeout = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancelTimeout?.();
  }
}
