import { describe, expect, it, vi } from "vitest";
import { createDispatcher, senderKind, type BridgeHandlers, type MessageSender, type PopupHandlers } from "../../../src/background/dispatch";
import { REQUEST_FAILED, type PopupRequest } from "../../../src/types/messages";

const runtime = { id: "ext-id", getURL: (path: string) => `chrome-extension://ext-id/${path}` };
const POPUP: MessageSender = { id: "ext-id", url: "chrome-extension://ext-id/src/popup/index.html" };
const WINDOW: MessageSender = { id: "ext-id", url: "chrome-extension://ext-id/src/popup/index.html?tabId=7", tab: { id: 99 } };
const ENGINE: MessageSender = { id: "ext-id", url: "chrome-extension://ext-id/src/engine/offscreen.html" };
const PAGE: MessageSender = { id: "ext-id", url: "https://evil.example/watch", tab: { id: 5, url: "https://evil.example/watch" }, frameId: 0 };

const choice = { outputMode: "Original", filename: "clip.mp4", variantId: null, audioRenditionId: null } as const;
/** One valid sample of every popup request. The record type fails to compile when a request has none. */
const REQUESTS: { readonly [T in PopupRequest["type"]]: Extract<PopupRequest, { type: T }> } = {
  "list": { type: "list", tabId: 1 },
  "rescan": { type: "rescan", tabId: 1 },
  "download-page": { type: "download-page", tabId: 1, pageUrl: "https://site.example/" },
  "download": { type: "download", streamId: "stream-1" as never, choice },
  "cancel": { type: "cancel", streamId: "stream-1" as never },
  "local-status": { type: "local-status" },
  "local-settings": { type: "local-settings", patch: { enabled: true } },
  "local-download": { type: "local-download", tabId: 1, pageUrl: "https://site.example/" },
  "local-cancel": { type: "local-cancel", id: "local-1" },
  "export-save-diagnostics": { type: "export-save-diagnostics", tabId: 1, pageUrl: "https://site.example/" },
  "current-save-state": { type: "current-save-state", tabId: 1, pageUrl: "https://site.example/" },
  "answer-repeat-save": { type: "answer-repeat-save", id: "p1", allow: true },
};

function handlers(popup: (msg: PopupRequest) => Promise<unknown>) {
  const each = Object.fromEntries(Object.keys(REQUESTS).map(type => [type, vi.fn(popup)])) as unknown as PopupHandlers;
  const bridge = { "frame-active": vi.fn(async () => ({ altS: true })), "download-best-hotkey": vi.fn(), "observed": vi.fn(), "eme": vi.fn(), "capture": vi.fn() };
  return { popup: each, bridge: bridge as unknown as BridgeHandlers, spies: { popup: each as unknown as Record<string, ReturnType<typeof vi.fn>>, bridge } };
}

/** Send and collect what was answered, after everything settled. */
async function send(dispatch: ReturnType<typeof createDispatcher>, msg: unknown, sender: MessageSender) {
  const replies: unknown[] = [];
  const keepOpen = dispatch(msg, sender, reply => { replies.push(reply); });
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  return { keepOpen, replies };
}

describe("who sent a message", () => {
  it("tells the popup, its detached window, the engine document, a page's script and everything else apart", () => {
    expect(senderKind(POPUP, runtime)).toBe("popup");
    expect(senderKind(WINDOW, runtime)).toBe("popup");
    expect(senderKind({ ...POPUP, url: `${POPUP.url}#x` }, runtime)).toBe("popup");
    expect(senderKind(ENGINE, runtime)).toBe("engine");
    expect(senderKind(PAGE, runtime)).toBe("content");
    expect(senderKind({ id: "ext-id", url: "about:srcdoc", tab: { id: 5 }, frameId: 3 }, runtime)).toBe("content");
    expect(senderKind({ ...PAGE, id: "other-extension" }, runtime)).toBe("foreign");
    expect(senderKind({ id: "ext-id", url: "chrome-extension://ext-id/src/engine/offscreen.html", tab: { id: 3 } }, runtime)).toBe("foreign");
    expect(senderKind({ id: "ext-id" }, runtime)).toBe("foreign");
    // A page cannot pass for the popup by putting its address in a query or a path.
    expect(senderKind({ id: "ext-id", url: "https://evil.example/?chrome-extension://ext-id/src/popup/index.html", tab: { id: 5 } }, runtime)).toBe("content");
  });
});

describe("the message dispatcher", () => {
  it.each(Object.values(REQUESTS))("answers the popup's $type exactly once with its handler's reply", async request => {
    const h = handlers(async msg => ({ handled: msg.type }));
    const { keepOpen, replies } = await send(createDispatcher(h, Promise.resolve(), runtime), request, POPUP);
    expect(keepOpen).toBe(true);
    expect(replies).toEqual([{ handled: request.type }]);
    expect(h.spies.popup[request.type]).toHaveBeenCalledExactlyOnceWith(request);
  });

  it.each(Object.values(REQUESTS))("answers the popup's $type exactly once with request-failed when its handler rejects", async request => {
    const h = handlers(async () => { throw new Error("boom"); });
    const error = vi.fn();
    const { replies } = await send(createDispatcher(h, Promise.resolve(), runtime, { debug() {}, info() {}, warn() {}, error }), request, POPUP);
    expect(replies).toEqual([REQUEST_FAILED]);
    expect(error).toHaveBeenCalledOnce();
  });

  it.each(Object.values(REQUESTS))("ignores the popup's $type from a page's content script, with no answer", async request => {
    const h = handlers(async () => ({ leaked: true }));
    for (const sender of [PAGE, ENGINE, { ...POPUP, id: "other" }]) {
      const { keepOpen, replies } = await send(createDispatcher(h, Promise.resolve(), runtime), request, sender);
      expect(keepOpen).toBe(false);
      expect(replies).toEqual([]);
    }
    expect(h.spies.popup[request.type]).not.toHaveBeenCalled();
  });

  it("takes a page's messages only from a page, with the tab from the sender", async () => {
    const h = handlers(async () => ({}));
    const dispatch = createDispatcher(h, Promise.resolve(), runtime);
    const observed = { type: "observed", url: "https://cdn.example/a.mp4", requestType: "media", mime: "video/mp4" };
    expect((await send(dispatch, observed, PAGE)).keepOpen).toBe(false);
    expect(h.spies.bridge.observed).toHaveBeenCalledExactlyOnceWith(observed, PAGE);
    // The popup and the engine never speak for a page.
    await send(dispatch, observed, POPUP);
    await send(dispatch, observed, ENGINE);
    await send(dispatch, { type: "capture", payload: { __savemedia: true, kind: "media-source", url: "https://x.example/a.mp4", pageUrl: "https://x.example/" } }, WINDOW);
    expect(h.spies.bridge.observed).toHaveBeenCalledOnce();
    expect(h.spies.bridge.capture).not.toHaveBeenCalled();
  });

  it("answers the one page message a frame waits on, also when its handler fails", async () => {
    const h = handlers(async () => ({}));
    const active = { type: "frame-active", reason: "load", url: "https://evil.example/watch" };
    const first = await send(createDispatcher(h, Promise.resolve(), runtime), active, PAGE);
    expect(first).toEqual({ keepOpen: true, replies: [{ altS: true }] });
    h.spies.bridge["frame-active"].mockRejectedValueOnce(new Error("boom"));
    expect((await send(createDispatcher(h, Promise.resolve(), runtime), active, PAGE)).replies).toEqual([null]);
  });

  it("ignores what is no message of the catalogue, from anyone", async () => {
    const h = handlers(async () => ({}));
    const dispatch = createDispatcher(h, Promise.resolve(), runtime);
    for (const msg of [null, "list", { type: "ready" }, { type: "list" }, { type: "start-job", streamId: "x" }, { type: "engine-connect" }]) {
      for (const sender of [POPUP, PAGE, ENGINE]) expect(await send(dispatch, msg, sender)).toEqual({ keepOpen: false, replies: [] });
    }
  });

  it("handles nothing before the stored state is back, and then in the order of arrival", async () => {
    const order: string[] = [];
    const h = handlers(async msg => { order.push(msg.type); return {}; });
    h.spies.bridge.observed.mockImplementation(() => { order.push("observed"); });
    let ready!: () => void;
    const dispatch = createDispatcher(h, new Promise<void>(resolve => { ready = resolve; }), runtime);
    const replies: unknown[] = [];
    dispatch(REQUESTS.list, POPUP, reply => replies.push(reply));
    dispatch({ type: "observed", url: "https://cdn.example/a.mp4", requestType: "media", mime: "" }, PAGE, () => undefined);
    dispatch(REQUESTS.rescan, POPUP, reply => replies.push(reply));
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(order).toEqual([]);
    expect(replies).toEqual([]);
    order.push("state-imported");
    ready();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(order).toEqual(["state-imported", "list", "observed", "rescan"]);
    expect(replies).toHaveLength(2);
  });
});
