import {
  NATIVE_HOST_NAME,
  NATIVE_RESPONSE_MAX_BYTES,
  type HostRequest,
  type HostResponse,
} from "./types";

/**
 * Typed wrapper around chrome.runtime.connectNative for the savemedia host.
 *
 * Manages:
 *   - one persistent port per process,
 *   - per-message nonces so concurrent requests don't cross-contaminate,
 *   - disconnect detection (host crash, manifest missing) → native_host_*
 *     error codes routed to whichever callers are waiting.
 *
 * Tests inject a fake port factory; production callers use the default
 * which calls `chrome.runtime.connectNative(NATIVE_HOST_NAME)`.
 */

export interface NativePort {
  onMessage: {
    addListener(cb: (msg: unknown) => void): void;
    removeListener(cb: (msg: unknown) => void): void;
  };
  onDisconnect: {
    addListener(cb: () => void): void;
  };
  postMessage(msg: unknown): void;
  disconnect(): void;
}

export type ConnectNative = () => NativePort;

/**
 * Distributive Omit over the discriminated union so each variant keeps its
 * own non-nonce fields. `Omit<HostRequest, "nonce">` collapses the union
 * and loses the per-variant fields.
 */
export type RequestWithoutNonce = HostRequest extends infer R
  ? R extends { nonce: string }
    ? Omit<R, "nonce">
    : never
  : never;

export class NativeHostNotAvailableError extends Error {
  constructor(public readonly detail: string) {
    super(`native host unavailable: ${detail}`);
  }
}

export class NativeHostProtocolError extends Error {
  constructor(public readonly detail: string) {
    super(`native host protocol error: ${detail}`);
  }
}

interface PendingRequest {
  readonly resolve: (response: HostResponse) => void;
  readonly reject: (err: unknown) => void;
  /** Predicate so a single request can keep waiting through progress events. */
  readonly accept: (response: HostResponse) => boolean;
}

export interface NativeBridge {
  request(req: RequestWithoutNonce, opts?: { acceptProgress?: boolean }): Promise<HostResponse>;
  requestStream(req: RequestWithoutNonce, onProgress: (msg: HostResponse) => void): Promise<HostResponse>;
  disconnect(): void;
  isConnected(): boolean;
}

export function createNativeBridge(connect: ConnectNative = defaultConnect): NativeBridge {
  let port: NativePort | null = null;
  const pending = new Map<string, PendingRequest>();
  let counter = 0;

  function ensurePort(): NativePort {
    if (port) return port;
    let opened: NativePort;
    try {
      opened = connect();
    } catch (err) {
      throw new NativeHostNotAvailableError(err instanceof Error ? err.message : String(err));
    }
    port = opened;
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(() => handleDisconnect());
    return port;
  }

  function handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object" || !("type" in raw) || !("nonce" in raw)) {
      return;
    }
    if (estimatedSize(raw) > NATIVE_RESPONSE_MAX_BYTES) {
      const nonce = String((raw as { nonce: unknown }).nonce);
      const waiter = pending.get(nonce);
      pending.delete(nonce);
      waiter?.reject(new NativeHostProtocolError("response exceeds 1 MB cap"));
      return;
    }
    const response = raw as HostResponse;
    const waiter = pending.get(response.nonce);
    if (!waiter) return;
    if (response.type === "error") {
      pending.delete(response.nonce);
      waiter.reject(new NativeHostProtocolError(`${response.code}: ${response.detail}`));
      return;
    }
    if (waiter.accept(response)) {
      pending.delete(response.nonce);
      waiter.resolve(response);
    }
  }

  function handleDisconnect(): void {
    const detail = chromeRuntimeError() ?? "disconnected";
    port = null;
    for (const waiter of pending.values()) {
      waiter.reject(new NativeHostNotAvailableError(detail));
    }
    pending.clear();
  }

  function nextNonce(): string {
    counter += 1;
    return `nm-${Date.now()}-${counter}`;
  }

  async function request(req: RequestWithoutNonce, opts: { acceptProgress?: boolean } = {}): Promise<HostResponse> {
    const accept = opts.acceptProgress ? (r: HostResponse) => r.type !== "progress" : () => true;
    return _send(req, accept, () => {});
  }

  async function requestStream(
    req: RequestWithoutNonce,
    onProgress: (msg: HostResponse) => void,
  ): Promise<HostResponse> {
    return _send(req, (r) => r.type !== "progress", onProgress);
  }

  function _send(
    req: RequestWithoutNonce,
    accept: (r: HostResponse) => boolean,
    onIntermediate: (msg: HostResponse) => void,
  ): Promise<HostResponse> {
    const nonce = nextNonce();
    const fullRequest = { ...req, nonce } as HostRequest;
    const liveAccept = (r: HostResponse) => {
      if (!accept(r)) {
        onIntermediate(r);
        return false;
      }
      return true;
    };
    return new Promise<HostResponse>((resolve, reject) => {
      pending.set(nonce, { resolve, reject, accept: liveAccept });
      try {
        ensurePort().postMessage(fullRequest);
      } catch (err) {
        pending.delete(nonce);
        reject(new NativeHostNotAvailableError(err instanceof Error ? err.message : String(err)));
      }
    });
  }

  function disconnect(): void {
    if (!port) return;
    try { port.disconnect(); } catch { /* ignore */ }
    handleDisconnect();
  }

  function isConnected(): boolean {
    return port !== null;
  }

  return { request, requestStream, disconnect, isConnected };
}

function defaultConnect(): NativePort {
  const runtime = (globalThis as unknown as { chrome?: { runtime?: { connectNative?: (name: string) => NativePort } } }).chrome?.runtime;
  if (!runtime?.connectNative) {
    throw new Error("chrome.runtime.connectNative is unavailable in this context");
  }
  return runtime.connectNative(NATIVE_HOST_NAME);
}

function chromeRuntimeError(): string | null {
  const err = (globalThis as unknown as { chrome?: { runtime?: { lastError?: { message?: string } } } }).chrome?.runtime?.lastError;
  return err?.message ?? null;
}

function estimatedSize(msg: unknown): number {
  try {
    return JSON.stringify(msg).length;
  } catch {
    return 0;
  }
}
