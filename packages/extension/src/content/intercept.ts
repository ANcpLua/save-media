import type { ResolvedMedia, SiteResolver } from "./sites/types";

// MAIN-world fetch/XHR interceptor. The page fetches its own media metadata
// with full session auth (cookies, CSRF, bot tokens); we read the *responses*
// it already receives rather than re-issuing or forging those requests. This
// is the same intercept-first idea as the transcript extension's YouTube hook.
//
// Contract: never throw into the page, never block a request, never mutate a
// body. We clone-and-read matching responses out of band and hand resolved
// URLs to `onMedia`.

/**
 * Pure core: does this response URL belong to the resolver, and if so what
 * media does its body yield? Split out so it unit-tests without patching
 * globals. `parse` is wrapped defensively — a body shape change must degrade
 * to "no media", never crash the page.
 */
export function extractCaptures(
  resolver: SiteResolver,
  requestUrl: string,
  bodyText: string,
): readonly ResolvedMedia[] {
  if (!resolver.matchesApi(requestUrl)) return [];
  try {
    return resolver.parse(bodyText);
  } catch {
    return [];
  }
}

interface InterceptTarget {
  fetch: typeof fetch;
  XMLHttpRequest: typeof XMLHttpRequest;
}

export function installInterceptor(
  resolver: SiteResolver,
  onMedia: (media: ResolvedMedia) => void,
  target: InterceptTarget = window,
): void {
  patchFetch(resolver, onMedia, target);
  patchXhr(resolver, onMedia, target);
}

function deliver(
  resolver: SiteResolver,
  onMedia: (media: ResolvedMedia) => void,
  url: string,
  bodyText: string,
): void {
  for (const media of extractCaptures(resolver, url, bodyText)) onMedia(media);
}

function patchFetch(
  resolver: SiteResolver,
  onMedia: (media: ResolvedMedia) => void,
  target: InterceptTarget,
): void {
  const original = target.fetch;
  if (typeof original !== "function") return;

  target.fetch = function patched(this: unknown, ...args: Parameters<typeof fetch>) {
    const promise = original.apply(this, args);
    try {
      const requestUrl = requestUrlFromFetchArgs(args);
      if (requestUrl !== null && resolver.matchesApi(requestUrl)) {
        void promise.then(response => {
          readResponseText(response).then(body => {
            if (body !== null) deliver(resolver, onMedia, requestUrl, body);
          });
        }).catch(() => undefined);
      }
    } catch {
      // Observation is best-effort; the page's request already flew.
    }
    return promise;
  } as typeof fetch;
}

function patchXhr(
  resolver: SiteResolver,
  onMedia: (media: ResolvedMedia) => void,
  target: InterceptTarget,
): void {
  const XHR = target.XMLHttpRequest;
  if (typeof XHR !== "function") return;
  const proto = XHR.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const urlKey = "__savemediaUrl";

  proto.open = function open(this: XMLHttpRequest, _method: string, url: string | URL) {
    try {
      (this as unknown as Record<string, unknown>)[urlKey] = typeof url === "string" ? url : url.href;
    } catch {
      // Read-only quirk on some hosts; drop the observation, keep the request.
    }
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as unknown as Parameters<XMLHttpRequest["open"]>);
  } as XMLHttpRequest["open"];

  proto.send = function send(this: XMLHttpRequest, ...sendArgs: Parameters<XMLHttpRequest["send"]>) {
    try {
      const url = (this as unknown as Record<string, unknown>)[urlKey];
      if (typeof url === "string" && resolver.matchesApi(url)) {
        this.addEventListener("load", () => {
          const body = xhrResponseText(this);
          if (body !== null) deliver(resolver, onMedia, url, body);
        });
      }
    } catch {
      // Never let observation break the send.
    }
    return originalSend.apply(this, sendArgs);
  } as XMLHttpRequest["send"];
}

function requestUrlFromFetchArgs(args: Parameters<typeof fetch>): string | null {
  const input = args[0];
  try {
    if (typeof input === "string") return new URL(input, location.href).href;
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
  } catch {
    return null;
  }
  return null;
}

async function readResponseText(response: Response): Promise<string | null> {
  try {
    return await response.clone().text();
  } catch {
    return null;
  }
}

function xhrResponseText(xhr: XMLHttpRequest): string | null {
  try {
    if (xhr.responseType === "" || xhr.responseType === "text") return xhr.responseText;
    if (xhr.responseType === "json") return JSON.stringify(xhr.response);
  } catch {
    return null;
  }
  return null;
}
