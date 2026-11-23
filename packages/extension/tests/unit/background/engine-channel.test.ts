import { describe, expect, it, vi } from "vitest";
import { createEngineChannel, createInProcessEngineChannel, EngineUnavailable, type EngineChannelDeps } from "../../../src/background/engine-channel";
import { ENGINE_PORT, type EngineHello } from "../../../src/types/messages";
import { directDescriptor } from "../popup/helpers/descriptors";

const ENGINE_URL = "chrome-extension://ext-id/src/engine/offscreen.html";
const choice = { outputMode: "Original", filename: "clip.mp4", variantId: null, audioRenditionId: null } as const;
const startJob = (id = "stream-1") => ({ type: "start-job", streamId: id as never, descriptor: directDescriptor(), choice }) as const;
const hello = (over: Partial<EngineHello> = {}): EngineHello => ({ type: "engine-hello", protocol: 1, active: [], outbox: [], retained: null, idle: false, ...over });
const turns = async (count = 8): Promise<void> => { for (let n = 0; n < count; n++) await Promise.resolve(); };

function fakePort(sender: object = { id: "ext-id", url: ENGINE_URL }, name: string = ENGINE_PORT) {
  const listeners = { message: [] as ((raw: unknown) => void)[], disconnect: [] as (() => void)[] };
  const port = {
    name, sender, posted: [] as unknown[],
    postMessage: vi.fn((message: unknown) => { port.posted.push(message); }),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: (raw: unknown) => void) => { listeners.message.push(listener); } },
    onDisconnect: { addListener: (listener: () => void) => { listeners.disconnect.push(listener); } },
    receive: (raw: unknown) => { for (const listener of listeners.message) listener(raw); },
    drop: () => { for (const listener of listeners.disconnect) listener(); },
  };
  return port;
}

/**
 * A browser for the channel: an engine document that exists or not, connects
 * its port when it is created or woken, and says hello.
 */
function world(over: Partial<EngineChannelDeps> = {}, options: { exists?: boolean; answers?: boolean; busy?: boolean } = {}) {
  let connect!: (port: ReturnType<typeof fakePort>) => void;
  const state = { exists: options.exists ?? false, answers: options.answers ?? true, busy: options.busy ?? false, port: null as ReturnType<typeof fakePort> | null };
  const log: string[] = [];
  function open(): ReturnType<typeof fakePort> {
    const port = fakePort();
    state.port = port;
    connect(port);
    queueMicrotask(() => port.receive(hello()));
    return port;
  }
  const deps: EngineChannelDeps = {
    ready: Promise.resolve(),
    onEvent: vi.fn(async () => undefined),
    onHello: vi.fn(async () => undefined),
    onLost: vi.fn(async when => { log.push(`lost:${when}`); }),
    busy: () => state.busy,
    prepareRequests: vi.fn(async () => undefined),
    host: {
      exists: vi.fn(async () => state.exists),
      create: vi.fn(async () => { log.push("create"); state.exists = true; }),
      close: vi.fn(async () => { log.push("close"); state.exists = false; }),
    },
    runtime: {
      id: "ext-id", getURL: path => `chrome-extension://ext-id/${path}`,
      onConnect: { addListener: listener => { connect = listener as never; } },
      wake: vi.fn(async () => {
        log.push("wake");
        if (!state.exists || !state.answers) return false;
        if (!state.port) open();
        return true;
      }),
    },
    ...over,
  };
  const channel = createEngineChannel(deps);
  return { channel, deps, state, log, connect: (port: ReturnType<typeof fakePort>) => connect(port), open };
}

describe("engine channel", () => {
  it("opens the engine document, waits for its hello, welcomes it, and only then hands over the job", async () => {
    const w = world();
    await w.channel.start(startJob());
    expect(w.log).toEqual(["create", "wake"]);
    expect(w.deps.onHello).toHaveBeenCalledOnce();
    expect(w.state.port!.posted[0]).toEqual({ type: "welcome" });
    expect(w.state.port!.posted[1]).toMatchObject({ type: "start-job", streamId: "stream-1" });
    // The next job uses the open port.
    await w.channel.start(startJob("stream-2"));
    expect(w.deps.host.create).toHaveBeenCalledOnce();
    expect(w.deps.runtime.wake).toHaveBeenCalledOnce();
  });

  it("knows a start that is still opening the engine from one that has reached it", async () => {
    const w = world();
    const starting = w.channel.start(startJob());
    expect(w.channel.isPending("stream-1")).toBe(true);
    await starting;
    expect(w.channel.isPending("stream-1")).toBe(false);
  });

  it("a document that exists but does not answer is closed and the start fails as engine unavailable", async () => {
    const w = world({}, { exists: true, answers: false });
    await expect(w.channel.start(startJob())).rejects.toEqual(new EngineUnavailable("start"));
    expect(w.log).toEqual(["wake", "close"]);
    expect(w.channel.isPending("stream-1")).toBe(false);
    // The next start gets a new document.
    w.state.answers = true;
    await w.channel.start(startJob());
    expect(w.log).toEqual(["wake", "close", "create", "wake"]);
  });

  it("a document that cannot be created fails the start", async () => {
    const w = world();
    vi.mocked(w.deps.host.create).mockRejectedValueOnce(new Error("no offscreen"));
    await expect(w.channel.start(startJob())).rejects.toBeInstanceOf(EngineUnavailable);
  });

  it("a port that drops without the background asking is a lost engine: reported once, and the dead document is cleared", async () => {
    const w = world();
    await w.channel.start(startJob());
    w.log.length = 0;
    w.state.busy = true;
    w.state.port!.drop();
    await turns();
    expect(w.log).toEqual(["lost:running", "close"]);
    // A retry opens a new engine.
    w.state.port = null;
    await w.channel.start(startJob());
    expect(w.log).toEqual(["lost:running", "close", "create", "wake"]);
  });

  it("logs an error nothing caught in the engine document as an error of the extension, and hands it to no job", async () => {
    const error = vi.fn();
    const w = world({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error } });
    await w.channel.start(startJob());
    w.state.port!.receive({ type: "engine-fault", detail: "TypeError: x is not a function" });
    await turns();
    expect(error).toHaveBeenCalledWith("engine fault", { error: "TypeError: x is not a function" });
    expect(w.deps.onEvent).not.toHaveBeenCalled();
    expect(w.deps.onLost).not.toHaveBeenCalled();
  });

  it("closes an idle engine itself, and that is not a lost engine", async () => {
    const w = world();
    await w.channel.start(startJob());
    const port = w.state.port!;
    w.log.length = 0;
    port.receive({ type: "idle" });
    await turns();
    expect(w.log).toEqual(["close"]);
    expect(port.disconnect).toHaveBeenCalledOnce();
    // The browser reports the port of the closed document as disconnected: nothing fails.
    port.drop();
    await turns();
    expect(w.deps.onLost).not.toHaveBeenCalled();
  });

  it("keeps the engine while a save or an image still needs it, also when the engine says it is idle", async () => {
    const w = world({}, { busy: true });
    await w.channel.start(startJob());
    w.state.port!.receive({ type: "idle" });
    w.state.port!.receive(hello({ idle: true }));
    await turns();
    expect(w.deps.host.close).not.toHaveBeenCalled();
  });

  it("a start during a close waits for it and gets a new document", async () => {
    const w = world();
    await w.channel.start(startJob());
    const first = w.state.port!;
    let closed!: () => void;
    vi.mocked(w.deps.host.close).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { closed = resolve; });
      w.log.push("close");
      w.state.exists = false;
    });
    w.log.length = 0;
    first.receive({ type: "idle" });
    await turns();
    w.state.port = null;
    const starting = w.channel.start(startJob("stream-2"));
    await turns();
    expect(w.log).toEqual([]);
    closed();
    await starting;
    expect(w.log).toEqual(["close", "create", "wake"]);
    expect(w.state.port).not.toBe(first);
    expect(w.state.port!.posted.at(-1)).toMatchObject({ type: "start-job", streamId: "stream-2" });
    expect(first.posted.some(message => (message as { streamId?: string }).streamId === "stream-2")).toBe(false);
  });

  it("answers a request to prepare a job's requests on every path", async () => {
    const w = world();
    await w.channel.start(startJob());
    vi.mocked(w.deps.prepareRequests).mockRejectedValueOnce(new Error("rule limit"));
    w.state.port!.receive({ type: "prepare-requests", requestId: 4, streamId: "stream-1", urls: ["https://cdn.example"] });
    w.state.port!.receive({ type: "prepare-requests", requestId: 5, streamId: "stream-1", urls: ["https://cdn.example"] });
    await turns();
    expect(w.deps.prepareRequests).toHaveBeenCalledWith("stream-1", ["https://cdn.example"]);
    expect(w.state.port!.posted.slice(-2)).toEqual([{ type: "requests-prepared", requestId: 4 }, { type: "requests-prepared", requestId: 5 }]);
  });

  it("passes the engine's reports on and ignores what is no engine message", async () => {
    const w = world();
    await w.channel.start(startJob());
    const progress = { type: "progress", streamId: "stream-1", bytesWritten: 1, bytesTotal: 2, stage: { kind: "downloading" } };
    w.state.port!.receive(progress);
    w.state.port!.receive({ type: "list", tabId: 1 });
    w.state.port!.receive({ type: "failed", streamId: "stream-1", error: "not an error" });
    await turns();
    expect(w.deps.onEvent).toHaveBeenCalledExactlyOnceWith(progress);
  });

  it("accepts the engine port only from the engine document", async () => {
    const w = world();
    for (const sender of [{ id: "ext-id", url: "https://evil.example/", tab: { id: 3 } }, { id: "ext-id", url: ENGINE_URL, tab: { id: 3 } },
      { id: "other", url: ENGINE_URL }, { id: "ext-id", url: "chrome-extension://ext-id/src/popup/index.html" }]) {
      const port = fakePort(sender);
      w.connect(port);
      port.receive(hello());
      await turns();
      expect(port.disconnect).toHaveBeenCalledOnce();
      expect(port.postMessage).not.toHaveBeenCalled();
    }
    expect(w.deps.onHello).not.toHaveBeenCalled();
    // A port of another name is someone else's.
    const view = fakePort({ id: "ext-id", url: "chrome-extension://ext-id/src/popup/index.html" }, "savemedia-view");
    w.connect(view);
    expect(view.disconnect).not.toHaveBeenCalled();
  });

  it("queues a cancel, a release and an acknowledgement until an engine is welcomed", async () => {
    const w = world({}, { exists: true });
    w.channel.cancel("stream-1");
    w.channel.release("blob:chrome-extension://ext-id/1");
    w.channel.ack("stream-2");
    const port = w.open();
    await turns();
    expect(port.posted).toEqual([{ type: "welcome" }, { type: "cancel-job", streamId: "stream-1" },
      { type: "release-output", blobUrl: "blob:chrome-extension://ext-id/1" }, { type: "ack", streamId: "stream-2" }]);
  });

  it("handles nothing before the stored state is back", async () => {
    let ready!: () => void;
    const w = world({ ready: new Promise<void>(resolve => { ready = resolve; }) }, { exists: true });
    const port = w.open();
    await turns();
    expect(w.deps.onHello).not.toHaveBeenCalled();
    expect(port.posted).toEqual([]);
    ready();
    await turns();
    expect(w.deps.onHello).toHaveBeenCalledOnce();
    expect(port.posted).toEqual([{ type: "welcome" }]);
  });

  describe("after a worker restart", () => {
    it("with no engine document, reports the engine as gone", async () => {
      const w = world();
      await w.channel.reconcile();
      expect(w.log).toEqual(["lost:restart"]);
      expect(w.deps.host.create).not.toHaveBeenCalled();
    });

    it("with an engine document, asks it to connect and takes in its account", async () => {
      const w = world({}, { exists: true });
      await w.channel.reconcile();
      expect(w.log).toEqual(["wake"]);
      expect(w.deps.onHello).toHaveBeenCalledOnce();
      expect(w.deps.onLost).not.toHaveBeenCalled();
    });

    it("with a document that no longer answers, clears it and reports the engine as gone", async () => {
      const w = world({}, { exists: true, answers: false });
      await w.channel.reconcile();
      expect(w.log).toEqual(["wake", "close", "lost:restart"]);
    });

    it("closes an engine that has nothing left to do", async () => {
      const w = world({}, { exists: true });
      vi.mocked(w.deps.runtime.wake).mockImplementationOnce(async () => {
        const port = fakePort();
        w.state.port = port;
        w.connect(port);
        queueMicrotask(() => port.receive(hello({ idle: true })));
        return true;
      });
      await w.channel.reconcile();
      await turns();
      expect(w.deps.host.close).toHaveBeenCalledOnce();
      expect(w.deps.onLost).not.toHaveBeenCalled();
    });
  });
});

describe("the engine inside the background page (Firefox)", () => {
  it("hands messages over as calls, reports through the same handler, and knows a restart took its jobs", async () => {
    const handled: unknown[] = [];
    let report!: (message: never) => void;
    const onEvent = vi.fn(async () => undefined);
    const onLost = vi.fn(async () => undefined);
    const channel = createInProcessEngineChannel(deps => {
      report = deps.sendToBackground as never;
      return { handleMessage: message => { handled.push(message); }, snapshot: () => ({ active: [], retained: null, idle: true }) };
    }, { ready: Promise.resolve(), onEvent, onLost, prepareRequests: async () => undefined });
    await channel.start(startJob());
    channel.cancel("stream-1");
    channel.release("blob:x");
    channel.ack("stream-1");
    expect(handled).toEqual([startJob(), { type: "cancel-job", streamId: "stream-1" }, { type: "release-output", blobUrl: "blob:x" }]);
    report({ type: "idle" } as never);
    await turns();
    expect(onEvent).toHaveBeenCalledWith({ type: "idle" });
    expect(channel.isPending("stream-1")).toBe(false);
    await channel.reconcile();
    expect(onLost).toHaveBeenCalledExactlyOnceWith("restart");
  });
});
