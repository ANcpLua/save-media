// The background's side of the engine. On Chromium the engine runs in an
// offscreen document and one port connects the two: it carries every message
// and is the liveness signal. A disconnect the background did not ask for
// means the engine document is gone (a crash, memory pressure, a close from
// elsewhere), and its jobs are failed so the user can save again. No timer
// decides anything here: every wait ends with a port event or a reply.
import {
  ENGINE_PORT, parseEngineToBackground,
  type BackgroundToEngineMessage, type EngineEvent, type EngineHello,
} from "../types/messages";
import type { InProcessEngineHost, InProcessEngineHostDeps } from "../engine/in-process-host";
import type { Logger } from "../util/logger";
import { fromWire, toWire } from "../util/wire";

const ENGINE_DOCUMENT_PATH = "src/engine/offscreen.html";

/** start: the engine could not be opened; running: it went away during a job; restart: it did not survive a worker restart. */
export type EngineLoss = "start" | "running" | "restart";

export class EngineUnavailable extends Error {
  constructor(readonly when: EngineLoss) {
    super(`engine unavailable: ${when}`);
    this.name = "EngineUnavailable";
  }
}

type StartMessage = Extract<BackgroundToEngineMessage, { type: "start-job" | "start-image" }>;

export interface EngineChannel {
  /** Open the engine if needed and hand it the job. Rejects with EngineUnavailable("start"). */
  start(message: StartMessage): Promise<void>;
  cancel(streamId: string): void;
  /** Free an output Blob; this also acknowledges the result that announced it. */
  release(blobUrl: string): void;
  /** Acknowledge a failure. */
  ack(streamId: string): void;
  /** A start of this worker instance is still opening the engine. */
  isPending(streamId: string): boolean;
  /** Once per worker start, after the stored state is back: find out what the engine did meanwhile. */
  reconcile(): Promise<void>;
}

interface PortLike {
  readonly name: string;
  readonly sender?: { readonly id?: string | undefined; readonly url?: string | undefined; readonly tab?: unknown } | undefined;
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
}

export interface EngineChannelDeps {
  /** Resolves when the stored state is back in memory. Nothing is handled before. */
  readonly ready: Promise<void>;
  readonly onEvent: (message: EngineEvent) => Promise<void>;
  readonly onHello: (hello: EngineHello) => Promise<void>;
  readonly onLost: (when: "running" | "restart") => Promise<void>;
  /** A job or an image save still needs the engine document. */
  readonly busy: () => boolean;
  readonly prepareRequests: (streamId: string, urls: readonly string[]) => Promise<void>;
  readonly host: { exists(): Promise<boolean>; create(): Promise<void>; close(): Promise<void> };
  readonly runtime: {
    readonly id: string;
    getURL(path: string): string;
    readonly onConnect: { addListener(listener: (port: PortLike) => void): void };
    /** Resolves true when the engine document answered { ok: true }; false when nothing answered. */
    wake(): Promise<boolean>;
  };
  readonly logger?: Logger;
}

const QUEUED: ReadonlySet<BackgroundToEngineMessage["type"]> = new Set(["cancel-job", "release-output", "ack", "requests-prepared"]);

export function createEngineChannel(deps: EngineChannelDeps): EngineChannel {
  let port: PortLike | null = null;
  let welcomed = false;
  const pendingStarts = new Set<string>();
  let waiters: { resolve(): void; reject(error: Error): void }[] = [];
  let queue: BackgroundToEngineMessage[] = [];

  // Opening and closing run one at a time, so a start during a close waits for it and then gets a new document.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = chain.then(operation, operation);
    chain = next.catch(() => undefined);
    return next;
  }

  function postNow(message: BackgroundToEngineMessage): boolean {
    if (!port || !welcomed) return false;
    try { port.postMessage(toWire(message)); return true; }
    catch { return false; }
  }

  function post(message: BackgroundToEngineMessage): void {
    if (!postNow(message) && QUEUED.has(message.type)) queue.push(message);
  }

  function welcomedPort(): Promise<void> {
    if (port && welcomed) return Promise.resolve();
    return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); });
  }

  function ensure(): Promise<void> {
    return serialized(async () => {
      if (port && welcomed) return;
      if (!await deps.host.exists().catch(() => false)) {
        try { await deps.host.create(); }
        catch { throw new EngineUnavailable("start"); }
      }
      const hello = welcomedPort();
      hello.catch(() => undefined);
      // The engine answers only after it has opened its port, so the hello is on its way when this resolves true.
      if (!await deps.runtime.wake().catch(() => false) && !(port && welcomed)) {
        // A document whose script never ran, or that is no longer alive.
        waiters = [];
        await deps.host.close().catch(() => undefined);
        throw new EngineUnavailable("start");
      }
      await hello;
    });
  }

  function closeIfIdle(): Promise<void> {
    return serialized(async () => {
      if (deps.busy() || pendingStarts.size) return;
      // Let go of the port first: what happens to it from here on is this close, not a lost engine.
      // Should the document survive the close, it has no port and connects again when it is next asked.
      const closed = port;
      port = null;
      welcomed = false;
      try { closed?.disconnect(); } catch { /* already gone */ }
      await deps.host.close().catch(() => undefined);
    });
  }

  async function receive(from: PortLike, raw: unknown): Promise<void> {
    const message = parseEngineToBackground(fromWire(raw));
    if (!message) { deps.logger?.warn("engine message not understood"); return; }
    await deps.ready;
    if (port !== from) return;
    if (message.type === "engine-hello") {
      await deps.onHello(message).catch(error => deps.logger?.error("engine hello failed", { error: String(error) }));
      if (port !== from) return;
      welcomed = true;
      const waiting = queue;
      queue = [];
      try {
        from.postMessage({ type: "welcome" } satisfies BackgroundToEngineMessage);
        for (const item of waiting) from.postMessage(toWire(item));
      } catch { return; }
      const resolved = waiters;
      waiters = [];
      for (const waiter of resolved) waiter.resolve();
      if (message.idle) void closeIfIdle();
      return;
    }
    if (message.type === "prepare-requests") {
      const { requestId } = message;
      // Answered on every path: the job goes on without the rules when preparing failed.
      void deps.prepareRequests(message.streamId, message.urls)
        .catch(error => deps.logger?.warn("prepare-requests failed", { error: String(error) }))
        .finally(() => post({ type: "requests-prepared", requestId }));
      return;
    }
    if (message.type === "idle") { void closeIfIdle(); return; }
    if (message.type === "engine-fault") { deps.logger?.error("engine fault", { error: message.detail }); return; }
    await deps.onEvent(message).catch(error => deps.logger?.error("engine event failed", { type: message.type, error: String(error) }));
  }

  async function disconnected(from: PortLike): Promise<void> {
    if (port !== from) return;
    port = null;
    welcomed = false;
    const rejected = waiters;
    waiters = [];
    for (const waiter of rejected) waiter.reject(new EngineUnavailable("start"));
    await deps.ready;
    await deps.onLost("running").catch(error => deps.logger?.error("engine loss handling failed", { error: String(error) }));
    // Clear a dead document, so the next job gets a new one.
    void serialized(() => deps.host.close().catch(() => undefined));
  }

  deps.runtime.onConnect.addListener(connected => {
    if (connected.name !== ENGINE_PORT) return;
    const sender = connected.sender;
    if (sender?.id !== deps.runtime.id || sender.url !== deps.runtime.getURL(ENGINE_DOCUMENT_PATH) || sender.tab !== undefined) {
      connected.disconnect();
      return;
    }
    port = connected;
    welcomed = false;
    connected.onMessage.addListener(raw => { void receive(connected, raw); });
    connected.onDisconnect.addListener(() => { void disconnected(connected); });
  });

  return {
    async start(message) {
      pendingStarts.add(message.streamId);
      try {
        await ensure();
        if (!postNow(message)) throw new EngineUnavailable("start");
      } finally {
        pendingStarts.delete(message.streamId);
      }
    },
    cancel: streamId => post({ type: "cancel-job", streamId: streamId as never }),
    release: blobUrl => post({ type: "release-output", blobUrl }),
    ack: streamId => post({ type: "ack", streamId: streamId as never }),
    isPending: streamId => pendingStarts.has(streamId),
    async reconcile() {
      if (!await deps.host.exists().catch(() => false)) { await deps.onLost("restart"); return; }
      try { await ensure(); }
      catch { await deps.onLost("restart"); }
    },
  };
}

/**
 * Firefox: the engine is a module of the background page. Messages are
 * plain calls. When the event page restarts, the engine and its jobs are
 * gone with it, which reconcile() reports.
 */
export function createInProcessEngineChannel(
  factory: (deps: InProcessEngineHostDeps) => InProcessEngineHost,
  deps: Pick<EngineChannelDeps, "ready" | "onEvent" | "onLost" | "prepareRequests" | "logger">,
): EngineChannel {
  const host = factory({
    sendToBackground: message => {
      void deps.ready.then(() => deps.onEvent(message)).catch(error => deps.logger?.error("engine event failed", { error: String(error) }));
    },
    prepareRequests: (streamId, urls) => deps.prepareRequests(streamId, urls).catch(() => undefined),
  });
  return {
    async start(message) { host.handleMessage(message); },
    cancel: streamId => host.handleMessage({ type: "cancel-job", streamId: streamId as never }),
    release: blobUrl => host.handleMessage({ type: "release-output", blobUrl }),
    ack: () => undefined,
    isPending: () => false,
    reconcile: () => deps.onLost("restart"),
  };
}
