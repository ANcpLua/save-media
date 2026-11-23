// MAIN world. One fetch and XMLHttpRequest observer for every consumer. The
// page fetches its own data with its own session; savemedia reads the
// responses the page already receives and never issues, blocks or changes a
// request. Nothing here throws into the page.

export interface ResponseWatcher {
  /** Whether this watcher reads a response with this address and Content-Type. Cheap: called for every response. */
  wants(url: string, contentType: string): boolean;
  /**
   * Whether a body that starts like this is worth reading on. Asked once
   * with the first part of the body, before the rest is read; a watcher
   * without it reads every body it wants.
   */
  wantsBody?(url: string, prefix: string): boolean;
  read(url: string, body: string | Document): void;
  /** The most characters of a body this watcher reads. Default 2 MiB. */
  readonly maxChars?: number;
}

interface ObserveTarget {
  fetch: typeof fetch;
  XMLHttpRequest: typeof XMLHttpRequest;
}

const DEFAULT_MAX_CHARS = 2 * 1024 * 1024;
/** How much of a body's start a watcher is shown before the rest is read. */
const PREFIX_CHARS = 1024;

function deliver(watchers: readonly ResponseWatcher[], url: string, body: string | Document): void {
  for (const watcher of watchers) {
    try { watcher.read(url, typeof body === "string" && body.length > (watcher.maxChars ?? DEFAULT_MAX_CHARS) ? body.slice(0, watcher.maxChars ?? DEFAULT_MAX_CHARS) : body); }
    catch { /* A body shape change must degrade to "nothing found". */ }
  }
}

function wanted(watchers: readonly ResponseWatcher[], url: string, contentType: string): ResponseWatcher[] {
  return watchers.filter(watcher => {
    try { return watcher.wants(url, contentType); } catch { return false; }
  });
}

/** The watchers that still want a body after seeing how it starts. */
function wantingBody(watchers: readonly ResponseWatcher[], url: string, prefix: string): ResponseWatcher[] {
  return watchers.filter(watcher => {
    try { return watcher.wantsBody?.(url, prefix) ?? true; } catch { return false; }
  });
}

/**
 * Read a clone for the watchers that want it, then let go of it. After the
 * first part the watchers are asked again, and a body none of them wants is
 * dropped unread.
 */
async function readBounded(response: Response, url: string, watchers: readonly ResponseWatcher[]): Promise<{ body: string; readers: ResponseWatcher[] } | null> {
  try {
    const reader = response.clone().body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let readers = [...watchers];
    let asked = false;
    let maxChars = Math.max(...readers.map(watcher => watcher.maxChars ?? DEFAULT_MAX_CHARS));
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!asked && text.trimStart() !== "") {
        asked = true;
        readers = wantingBody(readers, url, text.slice(0, PREFIX_CHARS));
        if (!readers.length) {
          void reader.cancel().catch(() => undefined);
          return null;
        }
        maxChars = Math.max(...readers.map(watcher => watcher.maxChars ?? DEFAULT_MAX_CHARS));
      }
      if (text.length >= maxChars) {
        void reader.cancel().catch(() => undefined);
        return { body: text.slice(0, maxChars), readers };
      }
    }
    return { body: text + decoder.decode(), readers };
  } catch { return null; }
}

function requestUrl(input: unknown): string | null {
  try {
    if (typeof input === "string") return new URL(input, location.href).href;
    if (input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  } catch { /* Not an address. */ }
  return null;
}

function patchFetch(watchers: readonly ResponseWatcher[], target: ObserveTarget): void {
  const original = target.fetch;
  if (typeof original !== "function") return;
  const patched = function patched(this: unknown, ...args: Parameters<typeof fetch>) {
    // The page gets its own promise back, untouched.
    const promise = original.apply(this, args);
    try {
      const requested = requestUrl(args[0]);
      if (requested !== null) {
        void promise.then(response => {
          const url = response.url || requested;
          const readers = wanted(watchers, url, response.headers.get("content-type") ?? "");
          if (!readers.length) return;
          return readBounded(response, url, readers).then(read => { if (read) deliver(read.readers, url, read.body); });
        }).catch(() => undefined);
      }
    } catch { /* Observation is best-effort; the page's request already left. */ }
    return promise;
  } as typeof fetch;
  // A hardened page can make fetch non-writable; then fetch is simply not observed.
  try { target.fetch = patched; } catch { /* Left as the page set it. */ }
}

function patchXhr(watchers: readonly ResponseWatcher[], target: ObserveTarget): void {
  const XHR = target.XMLHttpRequest;
  if (typeof XHR !== "function") return;
  const proto = XHR.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const urls = new WeakMap<XMLHttpRequest, string>();

  const patchedOpen = function open(this: XMLHttpRequest, _method: string, url: string | URL) {
    try { urls.set(this, new URL(typeof url === "string" ? url : url.href, location.href).href); } catch { /* Keep the request. */ }
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as unknown as Parameters<XMLHttpRequest["open"]>);
  } as XMLHttpRequest["open"];

  const patchedSend = function send(this: XMLHttpRequest, ...sendArgs: Parameters<XMLHttpRequest["send"]>) {
    try {
      if (urls.has(this)) {
        // Once: a reused request that sends again must not report a body twice.
        this.addEventListener("load", () => {
          try {
            const url = this.responseURL || urls.get(this)!;
            const readers = wanted(watchers, url, this.getResponseHeader("content-type") ?? "");
            if (!readers.length) return;
            const body = this.responseType === "document" ? this.responseXML
              : this.responseType === "" || this.responseType === "text" ? this.responseText
                : this.responseType === "json" ? JSON.stringify(this.response) : null;
            if (body === null || body === undefined) return;
            deliver(typeof body === "string" ? wantingBody(readers, url, body.slice(0, PREFIX_CHARS)) : readers, url, body);
          } catch { /* Never let observation break the page's handler chain. */ }
        }, { once: true });
      }
    } catch { /* Never let observation break the send. */ }
    return originalSend.apply(this, sendArgs);
  } as XMLHttpRequest["send"];

  try {
    proto.open = patchedOpen;
    proto.send = patchedSend;
  } catch {
    try { proto.open = originalOpen; } catch { /* Best effort. */ }
  }
}

export function observeResponses(watchers: readonly ResponseWatcher[], target: ObserveTarget = window): void {
  if (!watchers.length) return;
  patchFetch(watchers, target);
  patchXhr(watchers, target);
}
