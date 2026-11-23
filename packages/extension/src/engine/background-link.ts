// The engine document's side of the port to the background. The port carries
// every engine message and is the liveness signal in both directions. A
// result the background has not acknowledged is kept and sent again with the
// next hello, so a service worker restart loses neither a finished file nor a
// failure.
import {
  ENGINE_PORT, ENGINE_PROTOCOL, isEngineWake, parseBackgroundToEngine,
  type EngineEvent, type EngineHello, type EngineTerminal, type EngineToBackgroundMessage,
} from "../types/messages";
import { fromWire, toWire } from "../util/wire";
import type { InProcessEngineHost } from "./in-process-host";

interface PortLike {
  postMessage(message: unknown): void;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
}

export interface LinkRuntime {
  readonly id?: string | undefined;
  connect(info: { name: string }): PortLike;
  readonly onMessage: { addListener(listener: (message: unknown, sender: { id?: string | undefined; tab?: unknown },
    sendResponse: (reply: unknown) => void) => boolean | void): void };
}

export interface BackgroundLink {
  /** Report to the background. Queued while no welcomed port is open. */
  send(message: EngineEvent): void;
  /** Ask the background to prepare a job's requests. Settles either way: without the rules, requests go out as before. */
  prepareRequests(streamId: string, urls: readonly string[]): Promise<void>;
  /** Open the port now. The engine document calls it once it is ready to take a job. */
  start(): void;
}

function isTerminal(message: EngineEvent): message is EngineTerminal {
  return message.type === "complete" || message.type === "failed" || message.type === "image-complete";
}

export function createBackgroundLink(runtime: LinkRuntime, host: () => InProcessEngineHost): BackgroundLink {
  let port: PortLike | null = null;
  let welcomed = false;
  let queue: EngineEvent[] = [];
  const outbox = new Map<string, EngineTerminal>();
  /** The results the last hello carried. One that was produced after it is sent when the welcome arrives. */
  let announced = new Set<EngineTerminal>();
  const prepared = new Map<number, () => void>();
  let nextRequest = 1;

  function post(message: EngineToBackgroundMessage): boolean {
    try { port?.postMessage(toWire(message)); return port !== null; }
    catch { return false; }
  }

  function hello(): EngineHello {
    announced = new Set(outbox.values());
    return { type: "engine-hello", protocol: ENGINE_PROTOCOL, ...host().snapshot(), outbox: [...announced] };
  }

  function connect(): void {
    if (port) return;
    let opened: PortLike;
    try { opened = runtime.connect({ name: ENGINE_PORT }); }
    catch { return; }
    port = opened;
    welcomed = false;
    opened.onMessage.addListener(raw => { if (port === opened) receive(raw); });
    opened.onDisconnect.addListener(() => {
      if (port !== opened) return;
      const hadJobs = welcomed && host().snapshot().active.length > 0;
      port = null;
      welcomed = false;
      // The background is gone for now: requests go out without waiting for it.
      for (const settle of [...prepared.values()]) settle();
      // Jobs are running: connect again at once, which starts the background
      // again and lets it keep watching this engine.
      if (hadJobs) connect();
    });
    post(hello());
  }

  function receive(raw: unknown): void {
    const message = parseBackgroundToEngine(fromWire(raw));
    if (!message) return;
    if (message.type === "welcome") {
      welcomed = true;
      const waiting = queue;
      queue = [];
      for (const item of waiting) post(item);
      // A save that ended between the hello and its welcome: its result was in neither.
      for (const kept of outbox.values()) if (!announced.has(kept)) post(kept);
      return;
    }
    if (message.type === "requests-prepared") { prepared.get(message.requestId)?.(); return; }
    if (message.type === "ack") { outbox.delete(message.streamId); return; }
    if (message.type === "release-output") {
      for (const [id, kept] of outbox) if (kept.type !== "failed" && kept.blobUrl === message.blobUrl) outbox.delete(id);
    }
    host().handleMessage(message);
  }

  function send(message: EngineEvent): void {
    if (isTerminal(message)) outbox.set(message.streamId, message);
    if (welcomed && post(message)) return;
    // Of queued progress only the latest per job matters; per-request observations are not worth keeping.
    if (message.type === "transfer-http") return;
    if (message.type === "progress") queue = queue.filter(item => item.type !== "progress" || item.streamId !== message.streamId);
    if (message.type === "idle") queue = queue.filter(item => item.type !== "idle");
    // A result is sent again from the outbox with the hello.
    if (!isTerminal(message)) queue.push(message);
    connect();
  }

  runtime.onMessage.addListener((raw, sender, sendResponse) => {
    // Only the background asks, and it has no tab. Everything else on this channel is not for the engine.
    if (!isEngineWake(raw) || sender.tab !== undefined || (runtime.id !== undefined && sender.id !== runtime.id)) return false;
    connect();
    sendResponse({ ok: port !== null });
    return false;
  });

  return {
    send,
    start: connect,
    prepareRequests(streamId, urls) {
      return new Promise<void>(resolve => {
        const requestId = nextRequest++;
        const settle = (): void => { if (prepared.delete(requestId)) resolve(); };
        prepared.set(requestId, settle);
        if (!(welcomed && post({ type: "prepare-requests", requestId, streamId: streamId as never, urls }))) settle();
      });
    },
  };
}
