import { afterEach, describe, expect, it, vi } from "vitest";
import { closeEngineDocument, createEngineDocument, engineDocumentExists } from "../../../src/platform/processor-host/chromium";
import { createEngineChannel } from "../../../src/background/engine-channel";

const URL_ = "chrome-extension://abcdef/src/engine/offscreen.html";
afterEach(() => vi.unstubAllGlobals());

describe("the engine document on Chromium", () => {
  it("asks the browser for the offscreen document by its address", async () => {
    vi.mocked(chrome.runtime.getContexts).mockResolvedValueOnce([{ documentUrl: URL_ }] as never);
    expect(await engineDocumentExists()).toBe(true);
    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [URL_] });
    expect(await engineDocumentExists()).toBe(false);
  });

  it("on Chrome 114 and 115, without runtime.getContexts, finds it among the extension's window clients", async () => {
    delete (chrome.runtime as { getContexts?: unknown }).getContexts;
    const matchAll = vi.fn(async () => [{ url: "chrome-extension://abcdef/src/popup/index.html" }, { url: URL_ }]);
    vi.stubGlobal("clients", { matchAll });
    expect(await engineDocumentExists()).toBe(true);
    expect(matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    matchAll.mockResolvedValueOnce([{ url: "chrome-extension://abcdef/src/popup/index.html" }]);
    expect(await engineDocumentExists()).toBe(false);
  });

  it("creates it for Blob URLs and closes it without complaint when there is none", async () => {
    await createEngineDocument();
    expect(chrome.offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({ url: "src/engine/offscreen.html", reasons: ["BLOBS"] }));
    vi.mocked(chrome.offscreen.closeDocument).mockRejectedValueOnce(new Error("No current offscreen document"));
    await expect(closeEngineDocument()).resolves.toBeUndefined();
  });

  it("an existing document is never created a second time, and two starts at once create one", async () => {
    delete (chrome.runtime as { getContexts?: unknown }).getContexts;
    let exists = true;
    vi.stubGlobal("clients", { matchAll: async () => (exists ? [{ url: URL_ }] : []) });
    vi.mocked(chrome.offscreen.createDocument).mockImplementation(async () => { exists = true; });
    /** A channel whose engine document, once it exists, connects and says hello when it is woken. */
    function channel() {
      let connect!: (port: unknown) => void;
      let connected = false;
      return createEngineChannel({
        ready: Promise.resolve(), onEvent: async () => undefined, onHello: async () => undefined, onLost: async () => undefined, busy: () => true,
        prepareRequests: async () => undefined,
        host: { exists: engineDocumentExists, create: createEngineDocument, close: closeEngineDocument },
        runtime: { id: "abcdef", getURL: path => `chrome-extension://abcdef/${path}`, onConnect: { addListener: listener => { connect = listener as never; } },
          wake: async () => {
            if (!exists) return false;
            if (connected) return true;
            connected = true;
            let receive!: (raw: unknown) => void;
            connect({ name: "savemedia-engine", sender: { id: "abcdef", url: URL_ }, postMessage: () => undefined, disconnect: () => undefined,
              onMessage: { addListener: (listener: (raw: unknown) => void) => { receive = listener; } }, onDisconnect: { addListener: () => undefined } });
            queueMicrotask(() => receive({ type: "engine-hello", protocol: 1, active: [], outbox: [], retained: null, idle: false }));
            return true;
          } },
      });
    }
    const start = { type: "start-image", streamId: "image:1", url: "https://site.example/a.png" } as const;
    await channel().start(start);
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();

    exists = false;
    const both = channel();
    await Promise.all([both.start(start), both.start({ ...start, streamId: "image:2" })]);
    expect(chrome.offscreen.createDocument).toHaveBeenCalledOnce();
  });
});
