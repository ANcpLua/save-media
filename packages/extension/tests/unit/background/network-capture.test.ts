import { describe, expect, it, vi } from "vitest";
import { createTopDocumentAnswers, isExtractorManagedHost, managedSite, onDocumentAnswer, onResponse, onStoreExcludedSite, registerNetworkCapture } from "../../../src/background/network-capture";
import { MAIN_BRIDGE_TAG } from "../../../src/types/messages";

const details = (over: Partial<Parameters<typeof onResponse>[1]> = {}): Parameters<typeof onResponse>[1] => ({
  requestId: "r1", tabId: 7, frameId: 0, url: "https://cdn.example/clip.mp4", method: "GET", type: "media", statusCode: 200,
  ip: "93.184.216.34", documentId: "doc-0", documentLifecycle: "active", responseHeaders: [{ name: "Content-Type", value: "video/mp4" }], ...over });

function capture(frames: Record<number, string> = { 0: "https://news.example/story" }) {
  const handleCapture = Object.assign(vi.fn(async () => undefined), { clearTab: vi.fn(), abortUrl: vi.fn(), forget: vi.fn() });
  const deps = {
    handleCapture,
    store: { touch: vi.fn(() => false), noteReceived: vi.fn(), noteLocalOrigin: vi.fn(), noteFetched: vi.fn() },
    frames: { frameUrl: (_tabId: number, frameId: number) => frames[frameId], generation: () => 2 },
    tabUrl: vi.fn(async () => "https://fallback.example/"),
  };
  return { deps, handleCapture, redirects: new Map<string, string>() };
}

type AnyListener = (details: object) => void;
/** Registers the capture with the given dependencies and returns the listeners for the tab's own documents. */
function registerWith(made: { deps: Parameters<typeof registerNetworkCapture>[0] }) {
  const all: Record<string, { listener: AnyListener; filter: { types?: string[] } }[]> = {};
  const event = (name: string) => ({ addListener: (listener: AnyListener, filter: { types?: string[] }) => { (all[name] ??= []).push({ listener, filter }); } });
  (globalThis as unknown as { chrome: { webRequest: unknown } }).chrome.webRequest = {
    onBeforeRedirect: event("onBeforeRedirect"), onHeadersReceived: event("onHeadersReceived"), onResponseStarted: event("onResponseStarted") };
  registerNetworkCapture(made.deps);
  return { documents: Object.fromEntries(Object.entries(all).flatMap(([name, list]) =>
    list.filter(item => item.filter.types?.includes("main_frame")).map(item => [name, item]))) };
}

describe("network capture: what the browser itself received", () => {
  it("probes a media element's file by its response type, whatever its name", async () => {
    const { deps, handleCapture, redirects } = capture();
    for (const url of ["https://cdn.example/part-2.mp4", "https://cdn.example/segment-03-interview.mp4", "https://cdn.example/get?id=7"]) {
      await onResponse(deps, details({ url }), redirects);
    }
    expect(handleCapture.mock.calls.map(call => (call as unknown as [number, { payload: { url: string } }])[1].payload.url))
      .toEqual(["https://cdn.example/part-2.mp4", "https://cdn.example/segment-03-interview.mp4", "https://cdn.example/get?id=7"]);
  });

  it("passes where the request came from: frame, document, the frame's own address as Referer page, and the server address", async () => {
    const { deps, handleCapture, redirects } = capture({ 0: "https://news.example/story", 4: "https://player.example/embed/9" });
    await onResponse(deps, details({ frameId: 4, documentId: "doc-4", url: "https://cdn.example/clip.mp4#t=3" }), redirects);
    expect(handleCapture).toHaveBeenCalledWith(7, { type: "capture", payload: { [MAIN_BRIDGE_TAG]: true, kind: "media-source",
      url: "https://cdn.example/clip.mp4", pageUrl: "https://news.example/story" } }, {
      referrerPage: "https://player.example/embed/9",
      origin: { frameId: 4, documentId: "doc-4", via: ["network-media"], scope: null },
      credentials: "include", serverIp: "93.184.216.34",
      // The browser's own answer, by lower-case header name: an address named as an ad is listed from it without a request.
      observedHeaders: { "content-type": "video/mp4" } });
    expect(deps.store.noteReceived).toHaveBeenCalledWith(7, "https://cdn.example/clip.mp4", "93.184.216.34", expect.any(Number));
    expect(deps.tabUrl).not.toHaveBeenCalled();
  });

  it("notes nothing for an address longer than savemedia works with", async () => {
    const { deps, handleCapture, redirects } = capture();
    await onResponse(deps, details({ url: `https://cdn.example/${"a".repeat(9000)}.mp4` }), redirects);
    redirects.set("r2", `https://cdn.example/${"b".repeat(9000)}`);
    await onResponse(deps, details({ requestId: "r2", url: "https://cdn.example/final.mp4" }), redirects);
    expect(handleCapture).not.toHaveBeenCalled();
    expect(deps.store.noteReceived).not.toHaveBeenCalled();
    expect(deps.store.touch).not.toHaveBeenCalled();
  });

  it("finds an extensionless playlist a page fetched by its type, and keeps fetched fragments out", async () => {
    const { deps, handleCapture, redirects } = capture();
    await onResponse(deps, details({ type: "xmlhttprequest", url: "https://cdn.example/api/stream/9",
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }] }), redirects);
    expect(handleCapture).toHaveBeenCalledTimes(1);
    expect((handleCapture.mock.calls[0] as unknown as [number, unknown, { origin: { via: string[] } }])[2].origin.via).toEqual(["network-fetch"]);
    for (const [url, mime] of [["https://cdn.example/seg-1.m4s", "video/iso.segment"], ["https://cdn.example/seg-1.mp4", "video/mp4"],
      ["https://cdn.example/seg-1.ts", "video/mp2t"], ["https://cdn.example/data.json", "application/json"]]) {
      await onResponse(deps, details({ type: "xmlhttprequest", url: url!, responseHeaders: [{ name: "content-type", value: mime! }] }), redirects);
    }
    expect(handleCapture).toHaveBeenCalledTimes(1);
  });

  it("notes a video a script fetched whole, with the frame and document that asked and the server that answered, and requests nothing for it", async () => {
    const { deps, handleCapture, redirects } = capture({ 0: "https://news.example/story", 4: "https://player.example/embed/9" });
    const fetched = (over: Partial<Parameters<typeof onResponse>[1]>) => onResponse(deps, details({ type: "xmlhttprequest", ...over }), redirects);
    await fetched({ frameId: 4, documentId: "doc-4", url: "https://cdn.example/v/clip.mp4#t=1" });
    // The server that answered is kept in the note itself: the answer is not added to what the tab received.
    expect(deps.store.noteFetched).toHaveBeenCalledExactlyOnceWith(7, "https://cdn.example/v/clip.mp4", 4, "doc-4", "93.184.216.34");
    expect(deps.store.noteReceived).not.toHaveBeenCalled();
    expect(handleCapture).not.toHaveBeenCalled();
    // A range of a file, a fragment by its type, a transport stream, a request that is no GET, and a failed answer are not noted.
    for (const over of [{ statusCode: 206 }, { responseHeaders: [{ name: "content-type", value: "video/iso.segment" }] },
      { responseHeaders: [{ name: "content-type", value: "video/mp2t" }] }, { method: "POST" }, { statusCode: 404 }, { documentLifecycle: "prerender" }]) {
      await fetched({ url: "https://cdn.example/v/other.mp4", ...over } as Partial<Parameters<typeof onResponse>[1]>);
    }
    expect(deps.store.noteFetched).toHaveBeenCalledTimes(1);
    // A fetched file with an attachment header is checked at once, as before, and is not noted a second way.
    await fetched({ url: "https://cdn.example/get/9", responseHeaders: [{ name: "content-type", value: "video/mp4" }, { name: "content-disposition", value: "attachment; filename=\"a.mp4\"" }] });
    expect(handleCapture).toHaveBeenCalledTimes(1);
    expect(deps.store.noteFetched).toHaveBeenCalledTimes(1);
    // A page a site reader owns is left to its reader.
    const owned = capture({ 0: "https://www.youtube.com/watch?v=1" });
    await onResponse(owned.deps, details({ type: "xmlhttprequest", url: "https://cdn.example/v/clip.mp4" }), owned.redirects);
    expect(owned.deps.store.noteFetched).not.toHaveBeenCalled();
  });

  it("notes nothing for the pieces of a stream savemedia already knows: a player fed piece by piece costs no note per piece", async () => {
    const { deps, handleCapture, redirects } = capture();
    // The store says the address belongs to a known stream.
    vi.mocked(deps.store.touch).mockReturnValue(true);
    for (let piece = 0; piece < 50; piece++) {
      await onResponse(deps, details({ type: "xmlhttprequest", url: `https://cdn.example/v/seg-${piece}.mp4` }), redirects);
    }
    expect(deps.store.touch).toHaveBeenCalledTimes(50);
    expect(deps.store.noteFetched).not.toHaveBeenCalled();
    expect(deps.store.noteReceived).not.toHaveBeenCalled();
    expect(handleCapture).not.toHaveBeenCalled();
  });

  it("notes every media and fetch response as activity of the stream it belongs to, before deciding anything", async () => {
    const { deps, handleCapture, redirects } = capture();
    await onResponse(deps, details({ type: "xmlhttprequest", url: "https://cdn.example/v/seg7.m4s#x",
      responseHeaders: [{ name: "content-type", value: "video/iso.segment" }] }), redirects);
    expect(deps.store.touch).toHaveBeenCalledWith(7, "https://cdn.example/v/seg7.m4s", 0, 2);
    expect(handleCapture).not.toHaveBeenCalled();
  });

  it("requests nothing the browser did not receive: errors, other methods, other tabs and documents not on screen", async () => {
    const { deps, handleCapture, redirects } = capture();
    for (const over of [{ statusCode: 403 }, { statusCode: 404 }, { statusCode: 500 }, { method: "POST" }, { tabId: -1 },
      { documentLifecycle: "prerender" }, { documentLifecycle: "cached" }, { type: "image" }, { type: "script" }]) {
      await onResponse(deps, details(over), redirects);
    }
    expect(handleCapture).not.toHaveBeenCalled();
    expect(deps.store.noteReceived).not.toHaveBeenCalled();
  });

  it("does not probe audio, images or pages a media element loaded", async () => {
    const { deps, handleCapture, redirects } = capture();
    for (const mime of ["audio/mpeg", "audio/mp4", "image/png", "text/html", "application/json"]) {
      await onResponse(deps, details({ url: "https://cdn.example/asset", responseHeaders: [{ name: "content-type", value: mime }] }), redirects);
    }
    expect(handleCapture).not.toHaveBeenCalled();
  });

  it("keeps the entry address of a redirect chain and reports the final address as observed", async () => {
    const { deps, handleCapture, redirects } = capture();
    redirects.set("r9", "https://site.example/file/31");
    await onResponse(deps, details({ requestId: "r9", statusCode: 302, url: "https://site.example/file/31" }), redirects);
    expect(redirects.has("r9")).toBe(true);
    await onResponse(deps, details({ requestId: "r9", url: "https://cdn.example/signed?token=1" }), redirects);
    expect(redirects.has("r9")).toBe(false);
    expect(handleCapture).toHaveBeenCalledWith(7, expect.objectContaining({ payload: expect.objectContaining({ url: "https://site.example/file/31" }) }),
      expect.objectContaining({ observedUrl: "https://cdn.example/signed?token=1" }));
  });

  it("a frame without an address of its own acts for the page that made it: its creator's origin is the Referer page", async () => {
    const { deps, handleCapture, redirects } = capture({ 0: "https://news.example/story", 6: "about:srcdoc" });
    await onResponse(deps, { ...details({ frameId: 6 }), initiator: "https://news.example" }, redirects);
    expect(handleCapture).toHaveBeenCalledWith(7, expect.anything(), expect.objectContaining({ referrerPage: "https://news.example" }));
  });

  it("leaves pages with a site resolver to that resolver, and asks the browser for the tab address only when it is not recorded", async () => {
    const resolver = capture({ 0: "https://www.youtube.com/watch?v=1" });
    await onResponse(resolver.deps, details(), resolver.redirects);
    expect(resolver.handleCapture).not.toHaveBeenCalled();
    const unknown = capture({});
    await onResponse(unknown.deps, details(), unknown.redirects);
    expect(unknown.deps.tabUrl).toHaveBeenCalledWith(7);
    expect(unknown.handleCapture).toHaveBeenCalledWith(7, expect.objectContaining({ payload: expect.objectContaining({ pageUrl: "https://fallback.example/" }) }),
      expect.objectContaining({ referrerPage: "https://fallback.example/" }));
  });
});

describe("network capture registration", () => {
  type Listener = (details: object) => void;
  interface Registered { listener: Listener; filter: { urls: string[]; types?: string[] }; extra?: string[] }
  /** Every listener by event name, apart by what it listens for: `media` requests, and the tab's own `documents`. */
  function register(deps = capture()) {
    const all: Record<string, Registered[]> = {};
    const event = (name: string) => ({ addListener: (listener: Listener, filter: { urls: string[]; types?: string[] }, extra?: string[]) => {
      (all[name] ??= []).push({ listener, filter, ...(extra ? { extra } : {}) });
    } });
    (globalThis as unknown as { chrome: { webRequest: unknown } }).chrome.webRequest = {
      onBeforeRedirect: event("onBeforeRedirect"), onHeadersReceived: event("onHeadersReceived"), onResponseStarted: event("onResponseStarted") };
    registerNetworkCapture(deps.deps);
    const of = (types: string[]) => Object.fromEntries(Object.entries(all).flatMap(([name, list]) =>
      list.filter(item => JSON.stringify(item.filter.types) === JSON.stringify(types)).map(item => [name, item])));
    return { all, listeners: of(["media", "xmlhttprequest"]), documents: of(["main_frame", "sub_frame"]), ...deps };
  }

  it("listens for media element requests and fetch/XHR on two events, and takes a response once it has started", () => {
    const { all, listeners } = register();
    // The headers alone do not name the server address in every browser: the started response does.
    expect(Object.keys(all).sort()).toEqual(["onBeforeRedirect", "onResponseStarted"]);
    expect(Object.keys(listeners).sort()).toEqual(["onBeforeRedirect", "onResponseStarted"]);
    for (const { filter } of Object.values(listeners)) expect(filter).toEqual({ urls: ["<all_urls>"], types: ["media", "xmlhttprequest"] });
    expect(listeners["onResponseStarted"]!.extra).toEqual(["responseHeaders"]);
    expect(listeners["onBeforeRedirect"]!.extra).toBeUndefined();
  });

  it("listens for the tab's own documents apart, without their headers: one event per navigation, and nothing else of the browser's traffic", () => {
    const { all, documents } = register();
    expect(Object.keys(documents).sort()).toEqual(["onBeforeRedirect", "onResponseStarted"]);
    for (const { filter, extra } of Object.values(documents)) {
      expect(filter).toEqual({ urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] });
      expect(extra).toBeUndefined();
    }
    // Images, scripts, styles and fonts reach no listener at all.
    const types = new Set(Object.values(all).flat().flatMap(item => item.filter.types ?? ["every type"]));
    expect([...types].sort()).toEqual(["main_frame", "media", "sub_frame", "xmlhttprequest"]);
  });

  it("checks a started response with the server address the browser names for it", async () => {
    const { listeners, handleCapture, deps } = register();
    listeners["onResponseStarted"]!.listener(details({ ip: "10.20.0.5", url: "https://media.public-site.net/clip.mp4" }));
    await vi.waitFor(() => expect(handleCapture).toHaveBeenCalledTimes(1));
    expect(handleCapture.mock.calls[0]![2 as never]).toMatchObject({ serverIp: "10.20.0.5", credentials: "include" });
    // The origin was noted before the response was looked at.
    expect(deps.store.noteLocalOrigin.mock.invocationCallOrder[0]!).toBeLessThan(handleCapture.mock.invocationCallOrder[0]!);
  });

  it("never looks at a document for media: a page or frame answered from a public address changes nothing", async () => {
    const { documents, handleCapture, deps } = register();
    documents["onResponseStarted"]!.listener({ tabId: 7, frameId: 0, type: "main_frame", url: "https://news.example/story", ip: "93.184.216.34" });
    documents["onResponseStarted"]!.listener({ tabId: 7, frameId: 3, type: "sub_frame", url: "https://player.example/embed", ip: "93.184.216.34" });
    documents["onResponseStarted"]!.listener({ tabId: -1, frameId: 0, type: "main_frame", url: "https://wiki.corp.example/", ip: "10.1.2.3" });
    await Promise.resolve();
    expect(deps.store.noteLocalOrigin).not.toHaveBeenCalled();
    expect(handleCapture).not.toHaveBeenCalled();
    expect(deps.store.touch).not.toHaveBeenCalled();
  });
});

// The browser's own answer for a tab's page says where the browser reached that page's origin. A page under an
// intranet name, or any page behind a proxy inside the user's network, is answered from a local address.
describe("the tab's own documents, answered from inside the user's network", () => {
  const PAGE_URL = "https://wiki.corp.example/training.html";

  it("notes a frame's origin for the tab's document at once", () => {
    const { deps } = capture();
    onDocumentAnswer(deps, { tabId: 7, type: "sub_frame", url: "https://media.corp.example/player.html", ip: "10.1.2.3", documentLifecycle: "active" });
    expect(deps.store.noteLocalOrigin.mock.calls).toEqual([[7, "https://media.corp.example/player.html"]]);
    // A frame of a page loaded ahead of time is no frame of the document the tab shows.
    onDocumentAnswer(deps, { tabId: 7, type: "sub_frame", url: "https://other.corp.example/", ip: "10.1.2.3", documentLifecycle: "prerender" });
    expect(deps.store.noteLocalOrigin).toHaveBeenCalledTimes(1);
  });

  it("keeps the page's own origin until the tab shows the new document, because showing it clears what the tab knew", () => {
    const topDocuments = createTopDocumentAnswers();
    // The tab still shows the page before: nothing is noted for that page.
    const { deps } = capture({ 0: "https://news.example/story" });
    onDocumentAnswer({ ...deps, topDocuments }, { tabId: 7, type: "main_frame", url: PAGE_URL, ip: "10.1.2.3" });
    expect(deps.store.noteLocalOrigin).not.toHaveBeenCalled();
    // The tab shows another page than the one that was answered: nothing is taken, and the origin still waits.
    expect(topDocuments.take(7, "https://news.example/other")).toBeNull();
    expect(topDocuments.take(8, PAGE_URL)).toBeNull();
    // The new document is shown: its origin is handed over once.
    expect(topDocuments.take(7, PAGE_URL)).toBe("https://wiki.corp.example");
    expect(topDocuments.take(7, PAGE_URL)).toBeNull();
  });

  it("notes the page's origin at once when the tab already shows a document of that origin", () => {
    const topDocuments = createTopDocumentAnswers();
    const { deps } = capture({ 0: "https://wiki.corp.example/start" });
    onDocumentAnswer({ ...deps, topDocuments }, { tabId: 7, type: "main_frame", url: PAGE_URL, ip: "10.1.2.3" });
    expect(deps.store.noteLocalOrigin.mock.calls).toEqual([[7, PAGE_URL]]);
    expect(topDocuments.take(7, PAGE_URL)).toBe("https://wiki.corp.example");
  });

  it("forgets a closed tab, and keeps only a few origins of navigations that never showed a document", () => {
    const topDocuments = createTopDocumentAnswers();
    topDocuments.note(7, PAGE_URL);
    topDocuments.forget(7);
    expect(topDocuments.take(7, PAGE_URL)).toBeNull();
    for (let n = 0; n < 20; n++) topDocuments.note(7, `https://host-${n}.corp.example/file.zip`);
    expect(topDocuments.take(7, "https://host-0.corp.example/")).toBeNull();
    expect(topDocuments.take(7, "https://host-19.corp.example/")).toBe("https://host-19.corp.example");
    topDocuments.note(7, "ftp://files.corp.example/");
    expect(topDocuments.take(7, "ftp://files.corp.example/")).toBeNull();
  });

  it("is noted through the registered listeners: a redirect on the way to the page is an answer too", async () => {
    const topDocuments = createTopDocumentAnswers();
    const made = capture({});
    const withTop = { ...made, deps: { ...made.deps, topDocuments } };
    const { documents } = registerWith(withTop);
    documents["onBeforeRedirect"]!.listener({ tabId: 7, frameId: 0, type: "main_frame", url: "http://wiki.corp.example/", ip: "10.1.2.3" });
    documents["onResponseStarted"]!.listener({ tabId: 7, frameId: 0, type: "main_frame", url: PAGE_URL, ip: "10.1.2.3" });
    await Promise.resolve();
    expect(topDocuments.take(7, PAGE_URL)).toBe("https://wiki.corp.example");
    expect(topDocuments.take(7, "http://wiki.corp.example/")).toBe("http://wiki.corp.example");
  });
});

describe("origins the browser itself was answered from inside the user's network", () => {
  it("notes the origin of any answer from a local address, whatever its status or type, before anything else is decided", async () => {
    const { deps, handleCapture, redirects } = capture();
    await onResponse(deps, details({ url: "https://media.public-site.net/clip.mp4", ip: "10.20.0.5" }), redirects);
    await onResponse(deps, details({ url: "http://192.168.1.10/api/state", ip: "192.168.1.10", type: "xmlhttprequest", statusCode: 404,
      responseHeaders: [{ name: "content-type", value: "application/json" }] }), redirects);
    expect(deps.store.noteLocalOrigin.mock.calls).toEqual([[7, "https://media.public-site.net/clip.mp4"], [7, "http://192.168.1.10/api/state"]]);
    // Only the media answer is checked: the note alone requests nothing.
    expect(handleCapture).toHaveBeenCalledTimes(1);
  });

  it("notes nothing for an answer from the internet, for another method, or for a request that is not a tab's", async () => {
    const { deps, redirects } = capture();
    await onResponse(deps, details({ ip: "93.184.216.34" }), redirects);
    await onResponse(deps, details({ ip: "10.0.0.7", method: "POST" }), redirects);
    await onResponse(deps, details({ ip: "10.0.0.7", tabId: -1 }), redirects);
    await onResponse(deps, details({ ip: "10.0.0.7", documentLifecycle: "prerender" }), redirects);
    // A public name without a server address (an answer from the cache) says nothing about where it came from.
    await onResponse(deps, details({ ip: undefined, fromCache: true }), redirects);
    expect(deps.store.noteLocalOrigin).not.toHaveBeenCalled();
  });

  it("takes an address that is itself local when the browser names no server address, as for an answer from its cache", async () => {
    const { deps, redirects } = capture();
    await onResponse(deps, details({ url: "http://192.168.1.10:8080/movie.mp4", ip: undefined, fromCache: true }), redirects);
    await onResponse(deps, details({ url: "http://localhost:3000/movie.mp4", ip: undefined }), redirects);
    expect(deps.store.noteLocalOrigin.mock.calls.map(call => call[1])).toEqual(["http://192.168.1.10:8080/movie.mp4", "http://localhost:3000/movie.mp4"]);
  });

  it("notes the server that sent a redirect from a local address", () => {
    const listeners: Record<string, (details: object) => void> = {};
    const event = (name: string) => ({ addListener: (listener: (details: object) => void) => { listeners[name] = listener; } });
    (globalThis as unknown as { chrome: { webRequest: unknown } }).chrome.webRequest = {
      onBeforeRedirect: event("onBeforeRedirect"), onResponseStarted: event("onResponseStarted") };
    const { deps } = capture();
    registerNetworkCapture(deps);
    listeners["onBeforeRedirect"]!({ requestId: "1", tabId: 7, frameId: 0, method: "GET", url: "https://go.public-site.net/v", ip: "10.0.0.9",
      redirectUrl: "https://nas.public-site.net/v.mp4" });
    listeners["onBeforeRedirect"]!({ requestId: "2", tabId: 7, frameId: 0, method: "GET", url: "https://cdn.example/v", ip: "93.184.216.34",
      redirectUrl: "https://cdn.example/v.mp4" });
    listeners["onBeforeRedirect"]!({ requestId: "3", tabId: -1, frameId: 0, method: "GET", url: "https://own.public-site.net/v", ip: "10.0.0.9",
      redirectUrl: "https://own.public-site.net/v.mp4" });
    expect(deps.store.noteLocalOrigin.mock.calls).toEqual([[7, "https://go.public-site.net/v"]]);
  });
});

// Store packages (`bun run zip`) leave one site reader out and offer none of that site's media. Network capture
// skips its pages in every build; this is the test a store package applies to the checks the user asks for.
describe("the site store packages leave out", () => {
  it("is known by the page, by the frame that holds the player, and by the media address itself", () => {
    expect(onStoreExcludedSite("https://www.youtube.com/watch?v=abc", "https://www.youtube.com/watch?v=abc", "https://cdn.example/clip.mp4")).toBe(true);
    // An embedded player on another site's page.
    expect(onStoreExcludedSite("https://blog.example/post", "https://www.youtube-nocookie.com/embed/abc", "https://cdn.example/clip.mp4")).toBe(true);
    // An address a page's own player data declares.
    expect(onStoreExcludedSite("https://blog.example/post", "https://blog.example/post", "https://rr1---sn-test.googlevideo.com/videoplayback?itag=18")).toBe(true);
    expect(onStoreExcludedSite("https://m.youtube.com/watch?v=1")).toBe(true);
  });

  // The fact the selector gets: a store package says that it does not save from the site it leaves out,
  // and every build says that the reader found nothing where it has one (tests/unit/selection/main-video.test.ts).
  it("tells a page of a site with a reader from one of the site a store package leaves out, by the build", () => {
    const watch = "https://www.youtube.com/watch?v=abc";
    expect(managedSite(watch, true)).toBe("left-out");
    expect(managedSite(watch, false)).toBe("reader");
    for (const storeBuild of [true, false]) {
      expect(managedSite("https://x.com/user/status/1", storeBuild)).toBe("reader");
      expect(managedSite("https://www.instagram.com/reel/CxYz/", storeBuild)).toBe("reader");
      // An ordinary page, also one that embeds a player of such a site, and a tab without a page.
      expect(managedSite("https://blog.example/post", storeBuild)).toBeNull();
      expect(managedSite("https://youtube.com.evil.example/watch?v=1", storeBuild)).toBeNull();
      expect(managedSite(null, storeBuild)).toBeNull();
      expect(managedSite("garbage", storeBuild)).toBeNull();
    }
  });

  it("is no other site: the readers store packages keep, lookalike hosts, and addresses that are missing or malformed", () => {
    expect(onStoreExcludedSite("https://x.com/user/status/1", "https://www.instagram.com/reel/CxYz/", "https://video.twimg.com/a.mp4")).toBe(false);
    expect(onStoreExcludedSite("https://youtube.com.evil.example/watch?v=1", "https://notyoutube.com/", "https://cdn.example/googlevideo.com/a.mp4")).toBe(false);
    expect(onStoreExcludedSite(undefined, null, "", "garbage")).toBe(false);
    expect(onStoreExcludedSite()).toBe(false);
  });
});

describe("extractor-managed host gate", () => {
  it("recognises resolver-owned pages so generic discovery is suppressed", () => {
    expect(isExtractorManagedHost("https://x.com/user/status/1")).toBe(true);
    expect(isExtractorManagedHost("https://twitter.com/i/web/status/1")).toBe(true);
    expect(isExtractorManagedHost("https://mobile.twitter.com/home")).toBe(true);
    expect(isExtractorManagedHost("https://www.instagram.com/reel/CxYz/")).toBe(true);
    expect(isExtractorManagedHost("https://www.youtube.com/watch?v=1")).toBe(true);
    expect(isExtractorManagedHost("https://m.youtube.com/watch?v=1")).toBe(true);
    expect(isExtractorManagedHost("https://www.youtube-nocookie.com/embed/aQb2eDW4kzA")).toBe(true);
    // The youtube media CDN: `pageUrlFor` can fall back to the request URL
    // itself, and those fetches must not enter generic discovery either.
    expect(isExtractorManagedHost("https://rr3---sn-4g5edned.googlevideo.com/videoplayback?itag=137")).toBe(true);
  });

  it("leaves every other page to the generic path", () => {
    expect(isExtractorManagedHost("https://cdn.example/video/master.m3u8")).toBe(false);
    expect(isExtractorManagedHost("https://x.com.evil.com/")).toBe(false);
    expect(isExtractorManagedHost("https://youtube.com.evil.com/watch?v=1")).toBe(false);
    expect(isExtractorManagedHost("garbage")).toBe(false);
  });
});
