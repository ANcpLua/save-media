import { NATIVE_HOST_NAME } from "../types/native";
import { RangeRecoveryError } from "../engine/net/range-recovery";

export const FILE_CONNECTION_PORT = "savemedia-desktop-file";

export type FileFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Use Chrome first. A local connection is eligible only for a user-initiated HTTPS read. */
export function withDesktopRecovery(direct: FileFetch, pageUrl: string): FileFetch {
  const recovered = new Set<string>();
  let referrer: string | undefined;
  try {
    const page = new URL(pageUrl);
    if (page.protocol === "https:") referrer = page.origin;
  } catch { /* A local page may have no public referrer. */ }
  return async (url, init) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password || (init.method && init.method !== "GET")) {
      return direct(url, init);
    }
    if (!recovered.has(target.origin)) {
      try { return await direct(url, init); }
      catch (error) {
        init.signal?.throwIfAborted();
        if (!(error instanceof TypeError)) throw error;
      }
    }
    const response = await readDesktopFile(url, referrer, init);
    if (response.ok) recovered.add(target.origin);
    return response;
  };
}

/** Backpressure on the native port keeps a paused response from buffering the complete file. */
function readDesktopFile(url: string, referrer: string | undefined, init: RequestInit): Promise<Response> {
  init.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    // Offscreen documents expose runtime.connect, but Chrome reserves the
    // native port for the service worker. Both contexts use the same protocol.
    const port = typeof chrome.runtime.connectNative === "function"
      ? chrome.runtime.connectNative(NATIVE_HOST_NAME)
      : chrome.runtime.connect({ name: FILE_CONNECTION_PORT });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    let reading = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
      port.disconnect();
    };
    function fail(error: unknown): void {
      if (closed) return;
      controller?.error(error);
      reject(error);
      close();
    }
    const abort = () => fail(init.signal?.reason ?? new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => fail(new RangeRecoveryError("The installed downloader did not answer.")), 30000);
    init.signal?.addEventListener("abort", abort, { once: true });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      fail(new RangeRecoveryError("The local connection closed. Check that the SaveMedia downloader is installed and up to date."));
    });
    port.onMessage.addListener(msg => {
      if (closed || msg?.id !== id) return;
      if (msg.type === "failed") {
        fail(new RangeRecoveryError("The local downloader could not complete the secure file request."));
        return;
      }
      try {
        if (msg.type === "file-headers" && !controller) {
          if (!Number.isInteger(msg.status) || msg.status < 200 || msg.status > 599 || new URL(msg.url).protocol !== "https:") {
            throw new Error("Invalid local response headers");
          }
          clearTimeout(timer);
          const headers = new Headers(msg.headers);
          const body = new ReadableStream<Uint8Array>({
            start(c) { controller = c; },
            pull() {
              if (closed || reading) return;
              reading = true;
              port.postMessage({ type: "file-pull", id });
            },
            cancel: close,
          }, { highWaterMark: 0 });
          const empty = msg.status === 204 || msg.status === 205 || msg.status === 304;
          const response = new Response(empty ? null : body, { headers, status: msg.status });
          Object.defineProperty(response, "url", { value: msg.url });
          resolve(response);
          if (empty) close();
        } else if (controller && reading && msg.type === "file-chunk" && typeof msg.data === "string") {
          reading = false;
          const raw = atob(msg.data);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          controller.enqueue(bytes);
        } else if (controller && reading && msg.type === "file-end") {
          controller.close();
          close();
        } else throw new Error("Invalid local connection message");
      } catch { fail(new RangeRecoveryError("The installed downloader returned an unreadable response.")); }
    });
    const headers = new Headers(init.headers);
    try {
      port.postMessage({ type: "read-file", id, url, referrer,
        range: headers.get("range") ?? undefined, ifRange: headers.get("if-range") ?? undefined });
    } catch { fail(new RangeRecoveryError("The local downloader could not be reached.")); }
  });
}
