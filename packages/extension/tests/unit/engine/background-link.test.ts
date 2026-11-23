import { describe, expect, it, vi } from "vitest";
import { createBackgroundLink, type LinkRuntime } from "../../../src/engine/background-link";
import type { InProcessEngineHost } from "../../../src/engine/in-process-host";
import { ENGINE_PORT, parseEngineToBackground, type EngineEvent } from "../../../src/types/messages";

type Listener = (raw: unknown, sender: { id?: string; tab?: unknown }, respond: (reply: unknown) => void) => boolean | void;

function fakePort() {
  const listeners = { message: [] as ((raw: unknown) => void)[], disconnect: [] as (() => void)[] };
  const port = {
    posted: [] as { type: string; [key: string]: unknown }[],
    postMessage: (message: unknown) => { port.posted.push(message as never); },
    onMessage: { addListener: (listener: (raw: unknown) => void) => { listeners.message.push(listener); } },
    onDisconnect: { addListener: (listener: () => void) => { listeners.disconnect.push(listener); } },
    receive: (raw: unknown) => { for (const listener of listeners.message) listener(raw); },
    drop: () => { for (const listener of listeners.disconnect) listener(); },
  };
  return port;
}

function world() {
  const ports: ReturnType<typeof fakePort>[] = [];
  let onMessage!: Listener;
  const runtime: LinkRuntime = {
    id: "ext-id",
    connect: vi.fn(({ name }) => { expect(name).toBe(ENGINE_PORT); const port = fakePort(); ports.push(port); return port; }),
    onMessage: { addListener: listener => { onMessage = listener as Listener; } },
  };
  const state = { active: [] as { streamId: never; progress: null }[], retained: null as string | null, idle: true };
  const host: InProcessEngineHost = { handleMessage: vi.fn(), snapshot: () => ({ ...state }) };
  const link = createBackgroundLink(runtime, () => host);
  const wake = (sender: { id?: string; tab?: unknown } = { id: "ext-id" }, raw: unknown = { type: "engine-connect" }) => {
    const replies: unknown[] = [];
    onMessage(raw, sender, reply => replies.push(reply));
    return replies;
  };
  const welcome = (port = ports.at(-1)!) => port.receive({ type: "welcome" });
  return { link, runtime, ports, host, state, wake, welcome };
}

const progress = (bytes: number, streamId = "stream-1"): EngineEvent =>
  ({ type: "progress", streamId: streamId as never, bytesWritten: bytes, bytesTotal: 100, stage: { kind: "downloading" } });
const complete = { type: "complete", streamId: "stream-1" as never, blobUrl: "blob:chrome-extension://ext-id/1", filename: "a.mp4", checksum: "c" } as const;
const failed = { type: "failed", streamId: "stream-2" as never, error: { code: "user_cancelled", severity: "terminal", bytesDiscarded: 0 } } as const;

describe("the engine's link to the background", () => {
  it("opens its port and says what it is doing, in a hello the background accepts", () => {
    const w = world();
    w.state.active = [{ streamId: "stream-1" as never, progress: null }];
    w.state.idle = false;
    w.link.start();
    expect(w.ports).toHaveLength(1);
    expect(w.ports[0]!.posted).toEqual([{ type: "engine-hello", protocol: 1, active: [{ streamId: "stream-1", progress: null }], retained: null, idle: false, outbox: [] }]);
    expect(parseEngineToBackground(w.ports[0]!.posted[0])).not.toBeNull();
  });

  it("holds its reports until the background welcomed it, and of queued progress only the latest per save", () => {
    const w = world();
    w.link.start();
    w.link.send(progress(1));
    w.link.send(progress(2));
    w.link.send(progress(9, "stream-2"));
    w.link.send({ type: "transfer-http", streamId: "stream-1" as never, observation: {} as never });
    w.link.send({ type: "idle" });
    w.link.send({ type: "idle" });
    expect(w.ports[0]!.posted.map(message => message.type)).toEqual(["engine-hello"]);
    w.welcome();
    expect(w.ports[0]!.posted.slice(1)).toEqual([progress(2), progress(9, "stream-2"), { type: "idle" }]);
    w.link.send(progress(3));
    expect(w.ports[0]!.posted.at(-1)).toEqual(progress(3));
  });

  it("keeps a result until it is acknowledged, and reports it again with the next hello", () => {
    const w = world();
    w.link.start();
    w.welcome();
    w.link.send(complete);
    w.link.send(failed);
    // The background restarts: its port is gone.
    w.ports[0]!.drop();
    expect(w.ports).toHaveLength(1);
    // A new worker asks the engine to connect.
    expect(w.wake()).toEqual([{ ok: true }]);
    expect(w.ports).toHaveLength(2);
    expect(w.ports[1]!.posted[0]).toMatchObject({ type: "engine-hello", outbox: [complete, failed] });
    w.welcome();
    w.ports[1]!.receive({ type: "release-output", blobUrl: complete.blobUrl });
    w.ports[1]!.receive({ type: "ack", streamId: "stream-2" });
    expect(w.host.handleMessage).toHaveBeenCalledExactlyOnceWith({ type: "release-output", blobUrl: complete.blobUrl });
    w.ports[1]!.drop();
    w.wake();
    expect(w.ports[2]!.posted[0]).toMatchObject({ outbox: [] });
  });

  it("reports a save that ended between its hello and the welcome, once the welcome arrives", () => {
    const w = world();
    w.state.active = [{ streamId: "stream-1" as never, progress: null }];
    w.link.start();
    // The background is still reading its stored state. Meanwhile the save finishes.
    w.link.send(progress(100));
    w.link.send(complete);
    expect(w.ports[0]!.posted.map(message => message.type)).toEqual(["engine-hello"]);
    expect(w.ports[0]!.posted[0]).toMatchObject({ outbox: [] });
    w.welcome();
    expect(w.ports[0]!.posted.slice(1)).toEqual([progress(100), complete]);
    // A result the hello already carried is not sent a second time by the welcome.
    w.ports[0]!.drop();
    w.wake();
    w.welcome();
    expect(w.ports[1]!.posted.map(message => message.type)).toEqual(["engine-hello"]);
  });

  it("connects again at once when the background goes away while a save runs, which starts the background again", () => {
    const w = world();
    w.link.start();
    w.welcome();
    w.state.active = [{ streamId: "stream-1" as never, progress: null }];
    w.ports[0]!.drop();
    expect(w.ports).toHaveLength(2);
    expect(w.ports[1]!.posted[0]).toMatchObject({ type: "engine-hello", active: [{ streamId: "stream-1" }] });
    // With nothing running it waits to be asked, or until it has something to report.
    w.welcome();
    w.state.active = [];
    w.ports[1]!.drop();
    expect(w.ports).toHaveLength(2);
    w.link.send({ type: "idle" });
    expect(w.ports).toHaveLength(3);
  });

  it("hands the background's messages to the engine, bytes restored, and nothing that is no engine message", () => {
    const w = world();
    w.link.start();
    w.welcome();
    w.ports[0]!.receive({ type: "cancel-job", streamId: "stream-1" });
    w.ports[0]!.receive({ type: "list", tabId: 1 });
    w.ports[0]!.receive({ type: "start-job", streamId: "stream-1", descriptor: { nothing: true }, choice: {} });
    w.ports[0]!.receive({ type: "start-image", streamId: "image:1", url: "https://site.example/a.png" });
    expect(vi.mocked(w.host.handleMessage).mock.calls.map(call => call[0])).toEqual([
      { type: "cancel-job", streamId: "stream-1" }, { type: "start-image", streamId: "image:1", url: "https://site.example/a.png" }]);
  });

  it("answers only the background's request to connect: never a page's script, another extension or another message", () => {
    const w = world();
    expect(w.wake({ id: "ext-id", tab: { id: 4 } })).toEqual([]);
    expect(w.wake({ id: "other" })).toEqual([]);
    expect(w.wake({ id: "ext-id" }, { type: "start-job", streamId: "x" })).toEqual([]);
    expect(w.wake({ id: "ext-id" }, { type: "engine-connect", extra: 1 })).toEqual([]);
    expect(w.ports).toHaveLength(0);
    expect(w.host.handleMessage).not.toHaveBeenCalled();
    expect(w.wake()).toEqual([{ ok: true }]);
  });

  it("asks the background to prepare a save's requests and goes on when it answered, or when it is gone", async () => {
    const w = world();
    w.link.start();
    w.welcome();
    let settled = 0;
    const first = w.link.prepareRequests("stream-1", ["https://cdn.example"]).then(() => { settled++; });
    await Promise.resolve();
    expect(settled).toBe(0);
    const sent = w.ports[0]!.posted.at(-1)!;
    expect(sent).toEqual({ type: "prepare-requests", requestId: 1, streamId: "stream-1", urls: ["https://cdn.example"] });
    w.ports[0]!.receive({ type: "requests-prepared", requestId: 1 });
    await first;
    const second = w.link.prepareRequests("stream-1", ["https://cdn.example"]);
    w.ports[0]!.drop();
    await second;
    // Without a welcomed port there is nobody to wait for.
    await w.link.prepareRequests("stream-1", ["https://cdn.example"]);
  });
});
