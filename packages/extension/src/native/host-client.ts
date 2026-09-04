import {
  NATIVE_HOST_NAME,
  isHostToExtensionMessage,
  type ExtensionToHostMessage,
  type HostComplete,
  type HostFailed,
  type HostPong,
  type HostProgress,
  type HostToExtensionMessage,
  type CookieBrowser,
  type LocalQuality,
} from "../types/native";

/** Minimal shape of `chrome.runtime.Port` that the client relies on. */
export interface NativePortLike {
  readonly postMessage: (msg: ExtensionToHostMessage) => void;
  readonly disconnect: () => void;
  readonly onMessage: { readonly addListener: (listener: (msg: unknown) => void) => void };
  readonly onDisconnect: { readonly addListener: (listener: () => void) => void };
  /** Firefox reports the disconnect reason here instead of runtime.lastError. */
  readonly error?: { readonly message?: string } | undefined | null;
}

export interface NativeHostClientDeps {
  readonly connectNative: (name: string) => NativePortLike;
  /** Returns the connection error text after onDisconnect, if any (Chrome: runtime.lastError). */
  readonly lastError?: () => { readonly message?: string } | undefined | null;
}

export interface DownloadHandlers {
  readonly onProgress: (p: HostProgress) => void;
  readonly onComplete: (c: HostComplete) => void;
  readonly onFailed: (f: HostFailed) => void;
}

export interface DownloadRequest {
  readonly id: string;
  readonly pageUrl: string;
  readonly quality: LocalQuality;
  readonly cookiesFromBrowser: CookieBrowser | null;
  readonly outputDir: string | null;
}

export interface NativeHostClient {
  /** Opens a port, sends ping, resolves with the pong or null when unreachable. */
  readonly ping: (timeoutMs?: number) => Promise<HostPong | null>;
  /** Runs one download on its own port. Returns a cancel function. */
  readonly download: (req: DownloadRequest, handlers: DownloadHandlers) => () => void;
}

const DEFAULT_PING_TIMEOUT_MS = 8_000;

export function createNativeHostClient(deps: NativeHostClientDeps): NativeHostClient {
  const lastError = deps.lastError ?? (() => undefined);

  function open(): NativePortLike | null {
    try {
      return deps.connectNative(NATIVE_HOST_NAME);
    } catch {
      return null;
    }
  }

  function ping(timeoutMs = DEFAULT_PING_TIMEOUT_MS): Promise<HostPong | null> {
    return new Promise(resolve => {
      const port = open();
      if (!port) {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value: HostPong | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch { /* already gone */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      port.onMessage.addListener(msg => {
        if (isHostToExtensionMessage(msg) && msg.type === "pong") finish(msg);
      });
      port.onDisconnect.addListener(() => {
        void lastError(); // read it so Chrome does not log an unchecked lastError
        finish(null);
      });
      try {
        port.postMessage({ type: "ping" });
      } catch {
        finish(null);
      }
    });
  }

  function download(req: DownloadRequest, handlers: DownloadHandlers): () => void {
    const port = open();
    if (!port) {
      handlers.onFailed(unavailable(req.id, "connectNative threw"));
      return () => undefined;
    }
    let terminal = false;
    const fail = (f: HostFailed): void => {
      if (terminal) return;
      terminal = true;
      handlers.onFailed(f);
      try { port.disconnect(); } catch { /* already gone */ }
    };

    port.onMessage.addListener((raw: unknown) => {
      if (terminal || !isHostToExtensionMessage(raw)) return;
      const msg: HostToExtensionMessage = raw;
      if (msg.type === "pong") return;
      if (msg.id !== req.id) return;
      switch (msg.type) {
        case "progress":
          handlers.onProgress(msg);
          return;
        case "complete":
          terminal = true;
          handlers.onComplete(msg);
          try { port.disconnect(); } catch { /* already gone */ }
          return;
        case "failed":
          fail(msg);
          return;
      }
    });

    port.onDisconnect.addListener(() => {
      if (terminal) return;
      const err = lastError() ?? port.error;
      fail(unavailable(req.id, err?.message ?? "host disconnected before finishing"));
    });

    try {
      port.postMessage({
        type: "download",
        id: req.id,
        pageUrl: req.pageUrl,
        quality: req.quality,
        cookiesFromBrowser: req.cookiesFromBrowser,
        outputDir: req.outputDir,
      });
    } catch (e) {
      fail(unavailable(req.id, e instanceof Error ? e.message : String(e)));
    }

    return () => {
      if (terminal) return;
      try {
        port.postMessage({ type: "cancel", id: req.id });
      } catch {
        fail({ type: "failed", id: req.id, code: "cancelled", message: "cancelled" });
      }
    };
  }

  return { ping, download };
}

function unavailable(id: string, message: string): HostFailed {
  return { type: "failed", id, code: "host_unavailable", message };
}
