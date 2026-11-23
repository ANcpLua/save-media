// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://files.example/view/31"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bridge.ts is the ISOLATED-world entry. Importing it registers the
// runtime.onMessage listener that answers the background's requests for the
// frame's facts. It answers at once: nothing waits for the page.

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
let listener: Listener | null = null;
const sent: unknown[] = [];

beforeEach(async () => {
  document.body.innerHTML = "";
  sent.length = 0;
  // jsdom lays nothing out; give every element a box as a browser would.
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() =>
    [{ x: 0, y: 0, left: 0, top: 0, right: 80, bottom: 20, width: 80, height: 20 }] as unknown as DOMRectList);
  vi.mocked(globalThis.chrome.runtime.sendMessage).mockImplementation(((message: unknown, cb?: (response: unknown) => void) => {
    sent.push(message);
    cb?.(undefined);
  }) as never);
  if (listener) return;
  vi.mocked(globalThis.chrome.runtime.onMessage.addListener).mockImplementation((fn: unknown) => {
    listener = fn as Listener;
  });
  await import("../../../src/content/bridge");
});
afterEach(() => { vi.restoreAllMocks(); });

function ask(msg: unknown): unknown {
  let reply: unknown;
  // A synchronous answer: the listener must not keep the channel open.
  expect(listener!(msg, {}, response => { reply = response; })).toBe(false);
  return reply;
}

const pageState = () => (ask({ type: "collect-facts", pointer: false, thumbnails: false }) as { page: Record<string, unknown> }).page;

describe("the pointer record of the bridge", () => {
  // The newest record among a tab's frames decides where Alt+S looks. A page script can dispatch pointer
  // events (never trusted ones), so an ad frame doing that on a timer must not get a record at all.
  it("ignores pointer events a page script dispatched", () => {
    document.body.innerHTML = '<img src="/card.png" alt="">';
    const Pointer = (globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent;
    for (const type of ["pointermove", "pointerover"]) {
      window.dispatchEvent(new Pointer(type, { clientX: 10, clientY: 10, bubbles: true }));
      document.querySelector("img")!.dispatchEvent(new Pointer(type, { clientX: 10, clientY: 10, bubbles: true }));
    }
    expect((ask({ type: "collect-facts", pointer: true, thumbnails: false }) as { pointer: unknown }).pointer).toBeNull();
  });
});

describe("file page state from the bridge", () => {
  it("reports the declared link of a named file page", () => {
    document.body.innerHTML = '<h1>Clip 31.mov</h1><a href="/get/31" download>Download</a>';
    expect(pageState()).toMatchObject({ fileDownload: { filename: "Clip 31.mov", url: "https://files.example/get/31" } });
    expect(pageState()).not.toHaveProperty("namedFile");
    expect(ask({ type: "file-save-state", pageUrl: "https://files.example/view/31" })).toMatchObject({
      fileDownload: { filename: "Clip 31.mov", url: "https://files.example/get/31" }, fileSaveProblem: null });
    expect(ask({ type: "file-save-state", pageUrl: "https://files.example/other" })).toBeNull();
  });

  it("reports the file name alone, at once, when the page names a file but links to none", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<h1>Clip 31.mov</h1><button type="button">Download</button>';
    const state = pageState();
    expect(state).toMatchObject({ namedFile: "Clip 31.mov" });
    expect(state).not.toHaveProperty("fileDownload");
    // No timer was started to wait for the page.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it.each(["Holiday", "utils.ts"])("reports neither on a page whose heading %s names no media file by itself", heading => {
    document.body.innerHTML = `<h1>${heading}</h1><a href="/get/31">Download</a>`;
    expect(pageState()).not.toHaveProperty("fileDownload");
    expect(pageState()).not.toHaveProperty("namedFile");
  });

  it("remembers the last save problem for this page and reports it with the state", () => {
    document.body.innerHTML = '<h1>Clip 31.mov</h1><a href="/get/31" download>Download</a>';
    const problem = { filename: "Clip 31.mov", stage: "checking",
      error: { code: "network_unreachable", severity: "terminal", phase: "direct", url: "https://cdn.example/31.mov", during: "request" } };
    expect(ask({ type: "file-save-problem", pageUrl: "https://files.example/view/31", problem })).toEqual({ ok: true });
    expect(pageState()).toMatchObject({ fileSaveProblem: problem });
    ask({ type: "file-save-problem", pageUrl: "https://files.example/view/31", problem: null });
    expect(pageState()).toMatchObject({ fileSaveProblem: null });
  });

  it("keeps a save that could not start, and nothing that is not a problem's shape", () => {
    document.body.innerHTML = '<h1>Clip 31.mov</h1><a href="/get/31" download>Download</a>';
    const notStarted = { filename: "Clip 31.mov", stage: "starting", error: null };
    ask({ type: "file-save-problem", pageUrl: "https://files.example/view/31", problem: notStarted });
    expect(pageState()).toMatchObject({ fileSaveProblem: notStarted });
    for (const bad of [
      { filename: "Clip 31.mov", stage: "file connection", error: null },
      { filename: "Clip 31.mov", stage: "checking", error: { title: "prose" } },
      { filename: "Clip 31.mov", stage: "checking", title: "File server unavailable", body: "Try again.", code: "x" },
      { filename: 31, stage: "checking", error: null },
      "text",
    ]) {
      ask({ type: "file-save-problem", pageUrl: "https://files.example/view/31", problem: bad });
      expect(pageState()).toMatchObject({ fileSaveProblem: null });
    }
  });
});

describe("what a page can make the bridge pass on", () => {
  const post = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, source: window }));
  const captures = () => sent.filter(message => (message as { type?: string }).type === "capture") as { payload: Record<string, unknown> }[];

  it("passes ad addresses and resolver file addresses, stamped with the frame's own address, never the page's claim", () => {
    post({ __savemedia: true, kind: "ad-media", url: null, pageUrl: "https://victim.example/", adUrls: ["https://ads.example/a.mp4", "javascript:x", 7], adVia: "vast" });
    post({ __savemedia: true, kind: "media-source", url: "https://video.example/a.mp4", pageUrl: "http://192.168.1.1/", audioUrl: "https://video.example/a.m4a",
      quality: { groupId: "g" }, filenameHint: "evil.exe" });
    expect(captures().map(message => message.payload)).toEqual([
      { __savemedia: true, kind: "ad-media", url: null, pageUrl: "https://files.example/view/31", adUrls: ["https://ads.example/a.mp4"], adVia: "vast" },
      { __savemedia: true, kind: "media-source", url: "https://video.example/a.mp4", pageUrl: "https://files.example/view/31", audioUrl: "https://video.example/a.m4a" },
    ]);
  });

  it("drops everything else a page posts", () => {
    for (const data of [null, "text", { kind: "media-source", url: "https://a.example/a.mp4" },
      { __savemedia: true, kind: "eme", url: null, pageUrl: "x", keySystem: "com.widevine.alpha" },
      { __savemedia: true, kind: "media-element", url: "https://a.example/a.mp4", pageUrl: "x" },
      { __savemedia: true, kind: "media-source", url: "blob:https://a.example/1", pageUrl: "x" },
      { __savemedia: true, kind: "media-source", url: "https://a.example/a.mp4", pageUrl: "x", audioUrl: "file:///etc/passwd" },
      { __savemedia: true, kind: "ad-media", url: null, pageUrl: "x", adUrls: [], adVia: "vast" },
      { __savemedia: true, kind: "ad-media", url: null, pageUrl: "x", adUrls: ["https://ads.example/a.mp4"], adVia: "made-up" },
      { __savemedia: true, kind: "media-source", url: "https://a.example/" + "a".repeat(9000), pageUrl: "x" }]) post(data);
    window.dispatchEvent(new MessageEvent("message", { data: { __savemedia: true, kind: "media-source", url: "https://a.example/a.mp4", pageUrl: "x" }, source: null }));
    expect(captures()).toEqual([]);
  });

  it("cannot be made to start a save: no message from the page asks for the hotkey", () => {
    post({ type: "download-best-hotkey", pageUrl: "https://files.example/view/31" });
    post({ __savemedia: true, type: "download-best-hotkey" });
    expect(sent.filter(message => (message as { type?: string }).type === "download-best-hotkey")).toEqual([]);
  });
});

describe("key use on media elements", () => {
  const emes = () => sent.filter(message => (message as { type?: string }).type === "eme");

  it("reports a licence request once per element, and the element is keyed in the next facts", () => {
    document.body.innerHTML = '<video id="v" src="/clip.mp4"></video>';
    const video = document.querySelector("video")!;
    const event = () => video.dispatchEvent(new CustomEvent("savemedia:eme", { bubbles: true, composed: true,
      detail: JSON.stringify({ via: "license-request", keySystem: "org.w3.clearkey" }) }));
    event();
    expect(emes()).toEqual([{ type: "eme", via: "license-request", keySystem: "org.w3.clearkey", elementKey: expect.stringMatching(/^v\d+$/),
      elementSrc: "https://files.example/clip.mp4" }]);
    const facts = ask({ type: "collect-facts", pointer: false, thumbnails: false }) as { elements: { key: string; keyed: unknown }[] };
    expect(facts.elements).toEqual([expect.objectContaining({ key: (emes()[0] as { elementKey: string }).elementKey, keyed: { keySystem: "org.w3.clearkey" } })]);
  });

  it("reports an encrypted event, and leaves a video without key use unkeyed", () => {
    document.body.innerHTML = '<video id="a"></video><video id="b"></video>';
    document.querySelector("#a")!.dispatchEvent(new Event("encrypted"));
    expect(emes()).toEqual([{ type: "eme", via: "encrypted", keySystem: null, elementKey: expect.any(String), elementSrc: null }]);
    const facts = ask({ type: "collect-facts", pointer: false, thumbnails: false }) as { elements: { keyed: unknown }[] };
    expect(facts.elements.map(element => element.keyed)).toEqual([{ keySystem: null }, null]);
  });
});
