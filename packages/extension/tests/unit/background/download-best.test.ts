import { describe, expect, it, vi } from "vitest";
import {
  isAltSShortcut,
  registerDownloadBestCommand,
  saveFromHotkey,
  saveFromPopup,
  scanTab,
  type DownloadBestDeps,
  forgetHotkeyRun,
} from "../../../src/background/download-best";
import { createCaptureHandler, type CaptureDeps, type CaptureFetchResponse } from "../../../src/background/capture";
import { createRouter } from "../../../src/background/router";
import { createTabMediaStore, urlsOf } from "../../../src/background/tab-media";
import { select, type ProbeRequest } from "../../../src/selection/main-video";
import { MAIN_BRIDGE_TAG, type LocalJobView } from "../../../src/types/messages";
import type { TabFacts } from "../../../src/types/page-facts";
import { AMBIGUOUS_PLAYING_HINT, HOTKEY, IMAGE_REFUSALS, SITE_TEXTS, WAITING_HINTS } from "../../../src/ui/text";
import { dashDescriptor, drmDescriptor } from "../popup/helpers/descriptors";
import { PAGE, direct, el, facts, frame, group, hls, image, video } from "../selection/helpers";
import { engineStub } from "../helpers/engine";
import { noWaits } from "../helpers/waits";
import { answerRepeat, repeatPrompt, reserveSave, resetSaves } from "../../../src/background/session-saves";

const TAB = 42;
const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00]);
const ascii = (value: string): number[] => [...value].map(char => char.charCodeAt(0));
const box = (type: string, body: readonly number[] = []): number[] => [0, 0, 0, 8 + body.length, ...ascii(type), ...body];
const zeros = (length: number): number[] => new Array<number>(length).fill(0);
/** A whole MP4 file in small: file type, a movie box that declares no fragments, media data. */
const WHOLE_MP4 = new Uint8Array([...box("ftyp", [...ascii("mp42"), 0, 0, 0, 0]), ...box("moov", [...box("mvhd", zeros(20)), ...box("trak", zeros(20))]), ...box("mdat", zeros(32))]);
/** A fragment of a stream: a segment type box, a movie fragment and its media data. */
const FRAGMENT = new Uint8Array([...box("styp", [...ascii("msdh"), 0, 0, 0, 0]), ...box("moof", zeros(16)), ...box("mdat", zeros(16))]);
/** A QuickTime file's first box: the file type with the brand "qt  ". */
const QUICKTIME = new Uint8Array([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x00, 0x00, 0x71, 0x74, 0x20, 0x20]);

function response(contentType: string, body: Uint8Array | string, status = 200): CaptureFetchResponse {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { status, headers: { forEach: cb => cb(contentType, "content-type") }, text: async () => (typeof body === "string" ? body : ""),
    clone: () => ({ arrayBuffer: async () => buffer }) };
}

function localJob(): LocalJobView {
  return { id: "local-1", pageUrl: PAGE, tabId: TAB, phase: "probing", percent: null, downloadedBytes: null, totalBytes: null,
    speedBytesPerSec: null, etaSeconds: null, filename: null, failure: null };
}

/**
 * The real router, capture handler and selector behind the hotkey, with only
 * the page's facts and the network given. What Alt+S does here is what it
 * does in the extension.
 */
function world(page: TabFacts, fetchImpl: CaptureDeps["fetchFn"] = async () => response("video/mp4", MP4), overrides: Partial<DownloadBestDeps> = {}) {
  const store = createTabMediaStore();
  const { sent: engine, engine: channel } = engineStub();
  const router = createRouter({ engine: channel, downloads: { download: vi.fn(async () => 1) } });
  const fetchFn = vi.fn(fetchImpl);
  const handleCapture = createCaptureHandler({
    fetchFn,
    isAd: (tabId, url) => store.isAd(tabId, url),
    onDescriptor: (tabId, descriptor, origin) => {
      if (origin) store.recordOrigin(tabId, urlsOf(descriptor)[0]!, origin);
      router.addDescriptor(tabId, descriptor);
      store.indexOwners(tabId, descriptor);
    },
    onFailure: (tabId, failure, origin) => {
      if (origin) store.recordOrigin(tabId, failure.url, origin);
      router.setDiscoveryFailure(tabId, failure);
    },
    onProbeSuccess: (tabId, url) => void router.clearDiscoveryFailure(tabId, url),
    onPart: (tabId, url) => store.forgetFetched(tabId, url),
  });
  const probes: ProbeRequest[] = [];
  const deps: DownloadBestDeps = {
    tabs: { query: vi.fn(async () => [{ id: TAB, url: PAGE }]) },
    collect: vi.fn(async () => page),
    select: (tabId, given, usePointer) => select({ descriptors: router.descriptors(tabId), failures: router.failures(tabId), media: store.tab(tabId),
      jobs: router.activeJobs(tabId), facts: given, usePointer }),
    probe: (tabId, request, retryFailed) => {
      probes.push(request);
      return handleCapture(tabId, { type: "capture", payload: { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: request.url, pageUrl: PAGE,
        ...(request.groupId ? { quality: { groupId: request.groupId, ...(request.height ? { height: request.height } : {}) } } : {}),
        ...(request.filenameHint ? { filenameHint: request.filenameHint } : {}) } },
        { referrerPage: request.frameUrl, origin: { frameId: request.frameId, documentId: request.documentId,
          via: [request.via === "fetched" ? "network-fetch" : request.via], scope: request.via === "fetched" ? null : request.scope }, retryFailed,
          ...(request.via === "fetched" ? { wholeFile: true } : {}) });
    },
    runtime: { sendMessage: vi.fn() },
    router,
    showHotkeyFeedback: vi.fn(),
    ...overrides,
  };
  const toasts = () => vi.mocked(deps.showHotkeyFeedback).mock.calls.map(call => [call[1], call[2]]);
  const started = () => engine.mock.calls.map(call => call[0] as { type: string; streamId: string; descriptor?: { source: { url?: string } }; choice?: { filename: string } })
    .filter(message => message.type === "start-job");
  return { deps, router, store, fetchFn, probes, toasts, started };
}

const player = (key: string, address: string, over = {}) => el(key, { source: { kind: "url", url: address }, ...over });
const onPointer = (page: ReturnType<typeof frame>, ...layers: Parameters<typeof video>[0][]) =>
  ({ ...page, pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: layers.map(video) } });

describe("Alt+S", () => {
  it("checks the main player's own source and saves it", async () => {
    const w = world(facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] })));
    await saveFromHotkey(w.deps, TAB);
    expect(w.probes.map(request => [request.url, request.scope, request.via])).toEqual([["https://cdn.test/clip.mp4", "element", "element"]]);
    expect(w.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/clip.mp4"]);
    // The source is checked first, and the page says so before the check is sent. Then the label of the toast
    // says "Saving": the detail names what is saved and never repeats the label.
    expect(w.toasts()).toEqual([["preparing", "This page's video"], ["started", "Best quality"]]);
    // The save is recorded as Alt+S's own, so its end reaches the page as a toast (hotkey-jobs.ts).
    expect(w.router.job(w.started()[0]!.streamId)).toMatchObject({ tabId: TAB, origin: "hotkey" });
  });

  it("saves the video under the pointer, not the page's larger one", async () => {
    const big = player("big", "https://cdn.test/main.mp4", { box: { x: 0, y: 0, width: 960, height: 540 } });
    const small = player("small", "https://cdn.test/side.mp4", { box: { x: 0, y: 600, width: 320, height: 180 } });
    const w = world(facts(onPointer(frame(0, { elements: [big, small] }), "small")));
    await saveFromHotkey(w.deps, TAB);
    expect(w.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/side.mp4"]);
    expect(w.toasts()).toEqual([["preparing", "This page's video"], ["started", "This video"]]);
  });

  it("reports the failed check of the pointed video instead of saving another, and checks it again on the next press", async () => {
    const w = world(facts(onPointer(frame(0, { elements: [player("a", "https://cdn.test/a.mp4"), player("b", "https://cdn.test/b.mp4", { box: { x: 0, y: 500, width: 100, height: 60 } })] }), "a")),
      async url => url.includes("/a.mp4") ? response("text/html", "gone", 404) : response("video/mp4", MP4));
    await saveFromHotkey(w.deps, TAB);
    expect(w.started()).toEqual([]);
    // What happened and what to do, in the words the popup leads with. The status is a technical detail.
    expect(w.toasts().at(-1)).toEqual(["failed", "The server refused the file. Reload the page, start playback, then try again."]);
    expect(w.deps.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "job-failed", error: expect.objectContaining({ httpStatus: 404 }) }), expect.any(Function));
    const requests = w.fetchFn.mock.calls.length;
    await saveFromHotkey(w.deps, TAB);
    expect(w.fetchFn.mock.calls.length).toBeGreaterThan(requests);
    expect(w.started()).toEqual([]);
  });

  it.each([404, 522])("never hands a video its server refused or could not serve (HTTP %i) to the local downloader", async status => {
    noWaits();
    const localFallback = vi.fn(async () => localJob());
    const w = world(facts(onPointer(frame(0, { elements: [player("a", "https://cdn.test/a.mp4")] }), "a")),
      async () => response("text/html", "no", status), { localFallback });
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts().at(-1)![0]).toBe("failed");
    expect(w.started()).toEqual([]);
    expect(localFallback).not.toHaveBeenCalled();
  });

  it("gives an image under the pointer to the verified image save and reports what came back", async () => {
    const page = facts({ ...frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] }),
      pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [image("https://site.test/card.png")] } });
    const saveImage = vi.fn(async () => ({ kind: "saved", filename: "card.png" }) as const);
    const saved = world(page, undefined, { saveImage });
    await saveFromHotkey(saved.deps, TAB);
    expect(saveImage).toHaveBeenCalledWith({ url: "https://site.test/card.png", pageUrl: PAGE, loaded: false, tabId: TAB });
    expect(saved.toasts()).toEqual([["started", "Image"], ["complete", "card.png"]]);
    expect(saved.started()).toEqual([]);

    for (const [result, text] of [
      [{ kind: "refused", received: "page" }, IMAGE_REFUSALS.page], [{ kind: "refused", received: "program" }, IMAGE_REFUSALS.program],
      [{ kind: "page-only" }, "This image exists only inside the page. Right-click it and choose Save Image As."],
      [{ kind: "local-network" }, "This image is on your local network and this page is on the internet, so savemedia did not request it. Right-click it and choose Save Image As."],
      [{ kind: "failed", error: null }, "The image didn't arrive. Try again, or right-click it and choose Save Image As."],
      [{ kind: "failed", error: { code: "private_network_target", severity: "terminal", host: "nas.local" } },
        "This media is on your local network. Start playback on the page, then try again. savemedia saves what your browser itself loads."],
    ] as const) {
      const w = world(page, undefined, { saveImage: vi.fn(async () => result) });
      await saveFromHotkey(w.deps, TAB);
      expect(w.toasts().at(-1)).toEqual(["failed", text]);
    }
  });

  it("says an image that did not arrive as that, and gives the network's own account when the browser reported a block", async () => {
    const page = facts({ ...frame(0), pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [image("https://cdn.test/card.png")] } });
    const unreachable = { code: "network_unreachable", severity: "terminal", phase: "direct", url: "https://cdn.test", during: "request" } as const;
    for (const [error, text] of [
      // No answer, a dropped body, a stall: the image's own words, never "the video server".
      [unreachable, "The image didn't arrive. Try again, or right-click it and choose Save Image As."],
      [{ ...unreachable, during: "timeout" }, "The image didn't arrive. Try again, or right-click it and choose Save Image As."],
      // The browser's report names a block by the user's network: that is what is said.
      [{ ...unreachable, browserDiagnostic: { host: "cdn.test", code: "net::ERR_NAME_NOT_RESOLVED", ip: null, finalHost: null, redirect: null } },
        "Server not found. Check your connection. If other sites work, a network filter or the secure DNS setting in your browser's settings may block this server."],
      [{ code: "http_error", severity: "terminal", phase: "direct", url: "https://cdn.test", httpStatus: 404 }, null],
    ] as const) {
      const w = world(page, undefined, { saveImage: vi.fn(async () => ({ kind: "failed", error }) as const) });
      await saveFromHotkey(w.deps, TAB);
      const [outcome, detail] = w.toasts().at(-1)!;
      expect(outcome).toBe("failed");
      if (text) expect(detail).toBe(text);
      else expect(detail).not.toContain("The image didn't arrive");
    }
  });

  it("says nothing on the next page about an image of the page the tab has left", async () => {
    const page = facts({ ...frame(0), pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [image("https://cdn.test/card.png")] } });
    const w = world(page, undefined, { saveImage: vi.fn(async () => ({ kind: "left-page" }) as const) });
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts()).toEqual([["started", "Image"]]);
  });

  it("tells the image save whether the page shows the picture under the pointer", async () => {
    const page = facts({ ...frame(0), pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [image("http://192.168.1.10/cam.jpg", { loaded: true })] } });
    const saveImage = vi.fn(async () => ({ kind: "saved", filename: "cam.jpg" }) as const);
    const w = world(page, undefined, { saveImage });
    await saveFromHotkey(w.deps, TAB);
    expect(saveImage).toHaveBeenCalledWith({ url: "http://192.168.1.10/cam.jpg", pageUrl: PAGE, loaded: true, tabId: TAB });
    expect(w.toasts()).toEqual([["started", "Image"], ["complete", "cam.jpg"]]);
  });

  // Rule 11: the same press on the same image is one file. The reservation and the receipt are the real ones.
  it("saves an image once: a second Alt+S on it asks before a second copy and saves nothing by itself", async () => {
    resetSaves();
    Object.assign(chrome.tabs, { get: vi.fn(async () => ({ url: PAGE, active: false, windowId: 1 })) });
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((() => Promise.resolve(true)) as never);
    const page = facts({ ...frame(0), pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [image("https://site.test/img/card.png?v=2")] } });
    const saveImage = vi.fn(async () => ({ kind: "saved", filename: "card.png" }) as const);
    const reserveImage: NonNullable<DownloadBestDeps["reserveImage"]> = (tabId, pageUrl, pointed, name) =>
      reserveSave(["image", pointed.url], tabId, pageUrl, name, { request: { kind: "image", tabId, pageUrl, image: pointed } });
    const w = world(page, undefined, { saveImage, reserveImage });
    const question = () => vi.waitFor(() => {
      const prompt = repeatPrompt(TAB, PAGE);
      if (!prompt) throw new Error("no question is open yet");
      return prompt;
    });

    await saveFromHotkey(w.deps, TAB);
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(w.toasts()).toEqual([["started", "Image"], ["complete", "card.png"]]);

    // The second press: one question, named after the image, and no second file.
    const second = saveFromHotkey(w.deps, TAB);
    const asked = await question();
    expect(asked.filename).toBe("card.png");
    // A press while the question is open asks nothing new and saves nothing.
    forgetHotkeyRun(TAB);
    await saveFromHotkey(w.deps, TAB);
    expect(repeatPrompt(TAB, PAGE)?.id).toBe(asked.id);
    expect(await answerRepeat(asked.id, false)).toEqual({ ok: true });
    await second;
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(w.toasts()).toHaveLength(2);

    // "Save another copy" is the user's own choice: then, and only then, a second file is made.
    const third = saveFromHotkey(w.deps, TAB);
    await answerRepeat((await question()).id, true);
    await third;
    expect(saveImage).toHaveBeenCalledTimes(2);
    resetSaves();
  });

  it("writes no receipt for an image that was not saved, so the next press tries again without a question", async () => {
    resetSaves();
    const page = facts({ ...frame(0), pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [image("https://site.test/img/card.png")] } });
    const saveImage = vi.fn(async () => ({ kind: "failed", error: null }) as const);
    const w = world(page, undefined, { saveImage,
      reserveImage: (tabId, pageUrl, pointed, name) => reserveSave(["image", pointed.url], tabId, pageUrl, name) });
    await saveFromHotkey(w.deps, TAB);
    await saveFromHotkey(w.deps, TAB);
    expect(saveImage).toHaveBeenCalledTimes(2);
    expect(repeatPrompt(TAB, PAGE)).toBeNull();
    resetSaves();
  });

  it("saves the file a page names through the link the page declares, also with the pointer on its preview player", async () => {
    const offer = { filename: "Talk 31.mov", url: "https://site.test/file/31" };
    const preview = player("v1", "https://site.test/preview/31.mp4");
    const page = facts(onPointer(frame(0, { elements: [preview], page: { title: "Talk", fileDownload: offer } }), "v1"));
    const remember = vi.fn(async () => undefined);
    const w = world(page, undefined, { rememberFileSaveProblem: remember });
    await saveFromHotkey(w.deps, TAB);
    expect(w.probes.at(-1)).toMatchObject({ url: offer.url, filenameHint: "Talk 31.mov", via: "file-link" });
    expect(w.started()).toHaveLength(1);
    expect(w.started()[0]).toMatchObject({ descriptor: { source: { url: offer.url } }, choice: { filename: "Talk 31.mov" } });
    // "Checking" names the file. "Saving" names what is saved.
    expect(w.toasts()).toEqual([["preparing", "This page's video"], ["preparing", "Talk 31.mov"], ["started", "Best quality"]]);
    expect(remember).toHaveBeenCalledWith(TAB, PAGE, null);
    // The same press again while that save runs: nothing new starts, and the toast says so.
    await saveFromHotkey(w.deps, TAB);
    expect(w.started()).toHaveLength(1);
    expect(w.toasts().at(-1)).toEqual(["started", "Already in progress"]);
  });

  it("reports a declared file link that fails its check as that file's problem", async () => {
    const offer = { filename: "Talk 31.mov", url: "https://site.test/file/31" };
    const remember = vi.fn(async () => undefined);
    const w = world(facts(frame(0, { page: { title: "Talk", fileDownload: offer } })), async () => response("text/html", "denied", 403),
      { rememberFileSaveProblem: remember, tabs: { query: vi.fn(), isOnPage: vi.fn(async () => true) } });
    await saveFromHotkey(w.deps, TAB);
    expect(w.started()).toEqual([]);
    // The problem carries the error itself: the popup's file row and the toast word it the same way.
    expect(remember).toHaveBeenLastCalledWith(TAB, PAGE, { filename: "Talk 31.mov", stage: "checking",
      error: expect.objectContaining({ code: "access_denied", httpStatus: 403 }) });
    expect(w.toasts().at(-1)).toEqual(["failed", "The server refused access. Reload the page, start playback, then try again."]);
  });

  it("explains a certificate the browser refused for a named file exactly as for any other video", async () => {
    const offer = { filename: "Talk 31.mov", url: "https://site.test/file/31" };
    const remember = vi.fn(async () => undefined);
    const certificate = { code: "tls_certificate_rejected", severity: "terminal", phase: "direct",
      browserDiagnostic: { host: "site.test", code: "net::ERR_CERT_AUTHORITY_INVALID", ip: null, finalHost: null, redirect: null } } as const;
    const w = world(facts(frame(0, { page: { title: "Talk", fileDownload: offer } })), undefined,
      { rememberFileSaveProblem: remember, tabs: { query: vi.fn(), isOnPage: vi.fn(async () => true) } });
    Object.assign(w.deps, { probe: async () => { w.router.setDiscoveryFailure(TAB, { url: offer.url, error: certificate }); } });
    await saveFromHotkey(w.deps, TAB);
    expect(remember).toHaveBeenLastCalledWith(TAB, PAGE, { filename: "Talk 31.mov", stage: "checking", error: certificate });
    const toast = w.toasts().at(-1)!;
    expect(toast).toEqual(["failed", "Secure connection not trusted. Check your network filter or security software, or the secure DNS setting in your browser's settings."]);
    // One failure, one explanation: no second wording for a named file, and never "wait and try again".
    expect(toast[1]).not.toMatch(/File server unavailable|when the connection is available|later/i);
  });

  it("says a save could not start when nothing says why", async () => {
    const offer = { filename: "Talk 31.mov", url: "https://site.test/file/31" };
    const remember = vi.fn(async () => undefined);
    const w = world(facts(frame(0, { page: { title: "Talk", fileDownload: offer } })), undefined,
      { rememberFileSaveProblem: remember, tabs: { query: vi.fn(), isOnPage: vi.fn(async () => true) } });
    Object.assign(w.deps, { probe: async () => undefined });
    await saveFromHotkey(w.deps, TAB);
    expect(remember).toHaveBeenLastCalledWith(TAB, PAGE, { filename: "Talk 31.mov", stage: "checking", error: null });
    expect(w.toasts().at(-1)).toEqual(["failed", "Couldn't start the save. Reload the page and try again."]);
  });

  it.each([
    ["not-loaded-yet", facts(frame(0, { elements: [el("v1")] })), {}],
    ["file-not-received", facts(frame(0, { page: { title: "Talk", namedFile: "Talk 7.mov" } })), {}],
    ["ad-playing", facts(frame(0, { elements: [player("v1", "https://ads.test/creative.mp4", { playing: true })] })), { ad: "https://ads.test/creative.mp4" }],
  ] as const)("says what the page has not handed over yet (%s) and never passes that to the local downloader", async (state, page, setup) => {
    const localFallback = vi.fn(async () => localJob());
    const w = world(page, undefined, { localFallback });
    if ("ad" in setup) w.store.markAds(TAB, [setup.ad], "vast");
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts()).toEqual([["waiting", WAITING_HINTS[state]]]);
    expect(localFallback).not.toHaveBeenCalled();
    expect(w.fetchFn).not.toHaveBeenCalled();
    expect(w.started()).toEqual([]);
  });

  // Store packages on the site whose reader they leave out ("left-out"), and every build on a site with a reader that named nothing.
  it.each([
    ["left-out", "savemedia does not save videos from this site."],
    ["reader", "savemedia found no file it can save in this page's player data."],
  ] as const)("on a site read by a site reader alone (%s), says why there is nothing to save over a playing video, never 'start playback'", async (site, text) => {
    const playing = el("v1", { source: { kind: "blob", url: "blob:https://video.test/1" }, playing: true, played: true, audible: true });
    for (const elements of [[playing], [el("v1")]]) {
      const w = world(facts(onPointer(frame(0, { elements }), "v1")));
      const plain = w.deps.select;
      Object.assign(w.deps, { select: (tabId: number, given: TabFacts | null, usePointer: boolean) => select({ descriptors: w.router.descriptors(tabId),
        failures: w.router.failures(tabId), media: w.store.tab(tabId), jobs: w.router.activeJobs(tabId), facts: given, usePointer, site }) });
      await saveFromHotkey(w.deps, TAB);
      expect(w.toasts()).toEqual([["no-media", text]]);
      expect(w.started()).toEqual([]);
      expect(w.fetchFn).not.toHaveBeenCalled();
      // The same page without the fact is what the text replaces.
      Object.assign(w.deps, { select: plain });
      vi.mocked(w.deps.showHotkeyFeedback).mockClear();
      await saveFromHotkey(w.deps, TAB);
      expect(w.toasts()[0]![1]).not.toBe(text);
    }
    // The user's own Local downloader fallback takes the page, as on any page where savemedia has nothing to save.
    const localFallback = vi.fn(async () => localJob());
    const w = world(facts(onPointer(frame(0, { elements: [playing] }), "v1")), undefined, { localFallback });
    Object.assign(w.deps, { select: (tabId: number, given: TabFacts | null, usePointer: boolean) => select({ descriptors: [], failures: [],
      media: w.store.tab(tabId), jobs: new Set<string>(), facts: given, usePointer, site }) });
    await saveFromHotkey(w.deps, TAB);
    expect(localFallback).toHaveBeenCalledTimes(1);
    expect(w.toasts()).toEqual([["delegated", HOTKEY.delegated]]);
  });

  it("never tells the user to use a site's own controls", () => {
    for (const text of [...Object.values(WAITING_HINTS), ...Object.values(SITE_TEXTS), ...Object.values(IMAGE_REFUSALS), ...Object.values(HOTKEY), AMBIGUOUS_PLAYING_HINT]) {
      expect(text).not.toMatch(/button|site'?s own|download link/i);
    }
    expect(WAITING_HINTS["file-not-received"]).toBe("This file has not reached your browser yet. savemedia saves it once your browser receives it.");
    expect(WAITING_HINTS["not-loaded-yet"]).toBe("The page has not loaded the video yet. Start playback, then try again.");
  });

  it("a page that names no file and links one: the playing video under the pointer is saved, not the linked file", async () => {
    // <h1>Making of the album</h1>, a playing player, and <a download href=".../extras/trailer.mp4">: the page names no file,
    // so its facts carry no file offer and the link is one declared source among the page's media.
    const main = player("v1", "https://cdn.test/stream/main.mp4", { playing: true, played: true, audible: true });
    const link = group("https://cdn.test/extras/trailer.mp4", ["https://cdn.test/extras/trailer.mp4"], { via: "link", proximity: 3 });
    const w = world(facts(onPointer(frame(0, { elements: [main], pageGroups: [link], page: { title: "Making of the album" } }), "v1")));
    await saveFromHotkey(w.deps, TAB);
    expect(w.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/stream/main.mp4"]);
    expect(w.toasts().at(-1)![1]).toContain("This video");
  });

  it("does not ask the user to start a player that is already playing", async () => {
    const w = world(facts(onPointer(frame(0, { elements: [el("v1", { source: { kind: "blob", url: "blob:1" }, playing: true, played: true, audible: true })] }), "v1")));
    for (const n of [1, 2]) {
      w.router.addDescriptor(TAB, { ...hls(`s${n}`, `https://cdn.test/feed/${n}/media.m3u8`), tabId: TAB });
      w.store.recordOrigin(TAB, `https://cdn.test/feed/${n}/media.m3u8`, { frameId: 0, documentId: "doc-0", generation: 0, via: ["network-fetch"], scope: null });
    }
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts()).toEqual([["waiting", AMBIGUOUS_PLAYING_HINT]]);
    expect(AMBIGUOUS_PLAYING_HINT).not.toMatch(/start playback/i);
    expect(w.started()).toEqual([]);
  });

  it("lets go of a run that still waits for a page the tab has left, so the next press is served", async () => {
    let answer!: (page: TabFacts) => void;
    const stuck = new Promise<TabFacts>(resolve => { answer = resolve; });
    const page = facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] }));
    const collect = vi.fn<DownloadBestDeps["collect"]>().mockReturnValueOnce(stuck).mockResolvedValue(page);
    const w = world(page, undefined, { collect });
    const first = saveFromHotkey(w.deps, TAB);
    // A frame of the old page never answers. The tab shows a new document.
    forgetHotkeyRun(TAB);
    await saveFromHotkey(w.deps, TAB);
    expect(w.started()).toHaveLength(1);
    answer(page);
    await first;
  });

  it("a press that ended in a question to the user does not hold back the tab's next press", async () => {
    const first = player("first", "https://cdn.test/already-saved.mp4", { box: { x: 0, y: 0, width: 640, height: 360 } });
    const other = player("other", "https://cdn.test/other.mp4", { box: { x: 0, y: 400, width: 640, height: 360 } });
    const pages = [facts(onPointer(frame(0, { elements: [first, other] }), "first")), facts(onPointer(frame(0, { elements: [first, other] }), "other"))];
    const collect = vi.fn<DownloadBestDeps["collect"]>().mockResolvedValueOnce(pages[0]!).mockResolvedValue(pages[1]!);
    const w = world(pages[0]!, undefined, { collect });
    // The first video was saved before: its start waits for the user's answer, as session-saves makes it,
    // and the question's opening is announced the way index.ts wires it.
    let answer!: () => void;
    const startSelected = w.router.startSelected;
    const asked = vi.fn();
    Object.assign(w.deps, { router: { ...w.router, startSelected: vi.fn(async (...args: Parameters<typeof startSelected>) => {
      if (asked.mock.calls.length === 0) {
        asked();
        forgetHotkeyRun(TAB);
        await new Promise<void>(resolve => { answer = resolve; });
        return { kind: "skipped" as const };
      }
      return startSelected(...args);
    }) } });
    const waiting = saveFromHotkey(w.deps, TAB);
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    // The user leaves the question open, points at another video and presses Alt+S.
    await saveFromHotkey(w.deps, TAB);
    expect(w.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/other.mp4"]);
    // Each press checked its video's source first, and said so.
    expect(w.toasts()).toEqual([["preparing", "This page's video"], ["preparing", "This page's video"], ["started", "This video"]]);
    answer();
    await waiting;
  });

  it("does not guess between two MediaSource players it cannot tell apart", async () => {
    const posts = [el("v1", { source: { kind: "blob", url: "blob:1" } }), el("v2", { source: { kind: "blob", url: "blob:2" }, render: "offscreen" })];
    const localFallback = vi.fn(async () => localJob());
    const w = world(facts(onPointer(frame(0, { elements: posts }), "v1")), undefined, { localFallback });
    for (const n of [1, 2]) {
      const stream = hls(`s${n}`, `https://cdn.test/feed/${n}/media.m3u8`);
      w.router.addDescriptor(TAB, { ...stream, tabId: TAB });
      w.store.recordOrigin(TAB, `https://cdn.test/feed/${n}/media.m3u8`, { frameId: 0, documentId: "doc-0", generation: 0, via: ["network-fetch"], scope: null });
    }
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts()).toEqual([["waiting", WAITING_HINTS.ambiguous]]);
    expect(w.started()).toEqual([]);
    expect(localFallback).not.toHaveBeenCalled();
  });

  it("hands a page with nothing to save to the local downloader, and says so plainly when that declines", async () => {
    const accepted = world(facts(frame(0)), undefined, { localFallback: vi.fn(async () => localJob()) });
    await saveFromHotkey(accepted.deps, TAB);
    expect(accepted.deps.localFallback).toHaveBeenCalledWith(PAGE, TAB);
    expect(accepted.toasts()).toEqual([["delegated", "With yt-dlp on this computer"]]);
    const declined = world(facts(frame(0)), undefined, { localFallback: vi.fn(async () => null) });
    await saveFromHotkey(declined.deps, TAB);
    expect(declined.toasts()).toEqual([["no-media", "No media detected on this page."]]);
  });

  it("falls back for what only the browser engine cannot finish, such as DASH with no usable video track", async () => {
    const w = world(facts(frame(0)), undefined, { localFallback: vi.fn(async () => localJob()) });
    w.router.addDescriptor(TAB, { ...dashDescriptor({ variants: [] }), tabId: TAB });
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts()).toEqual([["delegated", "With yt-dlp on this computer"]]);
  });

  it("never delegates a Widevine-only page: through the browser's command and through the page's key event alike", async () => {
    for (const trigger of ["command", "page"] as const) {
      const localFallback = vi.fn(async () => localJob());
      const w = world(facts(frame(0)), undefined, { localFallback });
      w.router.addDescriptor(TAB, { ...drmDescriptor(), tabId: TAB });
      if (trigger === "command") {
        let listener!: (command: string) => void;
        registerDownloadBestCommand({ onCommand: { addListener: registered => { listener = registered; } } }, w.deps);
        listener("some-other-command");
        expect(w.deps.tabs.query).not.toHaveBeenCalled();
        listener("download-best");
        await vi.waitFor(() => expect(w.toasts()).toHaveLength(1));
        expect(w.deps.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      } else await saveFromHotkey(w.deps, TAB);
      // Protection has no hint: nothing the user can do changes it.
      expect(w.toasts().at(-1)).toEqual(["failed", "Protected video"]);
      expect(w.deps.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "job-failed", error: expect.objectContaining({ code: "cdm_required" }) }), expect.any(Function));
      expect(localFallback).not.toHaveBeenCalled();
      expect(w.started()).toEqual([]);
    }
  });

  it("a playing MediaSource player whose stream is captured is saved at once: a stale address in its data is not requested again on every press", async () => {
    const stale = "https://old-media.test/clip/master.m3u8";
    const played = "https://cdn.test/live/media.m3u8";
    const blob = { kind: "blob", url: "blob:https://site.test/1" } as const;
    const page = facts(frame(0, { elements: [el("v1", { source: blob, playing: true, groups: [group("config", [stale])] })] }));
    const w = world(page, async address => address.includes("old-media") ? response("text/html", "gone", 404) : response("video/mp4", MP4));
    w.router.addDescriptor(TAB, { ...hls("played", played), tabId: TAB });
    w.store.recordOrigin(TAB, played, { frameId: 0, documentId: "doc-0", generation: 0, via: ["network-fetch"], scope: null });

    // The first press checks the address the player's data names, once, and says "Checking" before it does.
    await saveFromHotkey(w.deps, TAB);
    expect(w.probes.map(request => request.url)).toEqual([stale]);
    expect(w.toasts()).toEqual([["preparing", "This page's video"], ["started", expect.stringContaining("Best quality")]]);
    expect(w.started().map(message => message.streamId)).toEqual(["played"]);
    expect(w.router.failures(TAB).map(failure => failure.url)).toEqual([stale]);

    // Every later press, and the popup's Save, start from what is known: nothing is requested, nothing is "checked".
    const requests = w.fetchFn.mock.calls.length;
    await saveFromHotkey(w.deps, TAB);
    await saveFromPopup(w.deps, TAB, PAGE);
    expect(w.probes).toHaveLength(1);
    expect(w.fetchFn.mock.calls.length).toBe(requests);
    expect(w.toasts().slice(2)).toEqual([["started", "Already in progress"]]);

    // Looking at the page again is the user's request to check what failed again.
    await scanTab(w.deps, TAB, { pointer: false, thumbnails: false, retryFailed: true, list: true });
    expect(w.probes.map(request => [request.url, request.retry])).toEqual([[stale, false], [stale, true]]);
  });

  it("says Checking before a check is sent, so a slow server is never met with silence", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const w = world(facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] })), async () => { await held; return response("video/mp4", MP4); });
    const press = saveFromHotkey(w.deps, TAB);
    await vi.waitFor(() => expect(w.fetchFn).toHaveBeenCalled());
    expect(w.toasts()).toEqual([["preparing", "This page's video"]]);
    release();
    await press;
    expect(w.toasts().at(-1)).toEqual(["started", "Best quality"]);
    // Nothing is left to check on the next press: it says only what happens.
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts().slice(2)).toEqual([["started", "Already in progress"]]);
  });

  it("one press is one save: the command and the page's key event for the same press join", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const w = world(facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] })), async () => { await held; return response("video/mp4", MP4); });
    const first = saveFromHotkey(w.deps, TAB);
    const second = saveFromHotkey(w.deps, TAB);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);
    expect(w.started()).toHaveLength(1);
    // One "Checking", shown while the server had not answered yet, and one "Saving": the joined press adds nothing.
    expect(w.toasts()).toEqual([["preparing", "This page's video"], ["started", "Best quality"]]);
    expect(w.deps.collect).toHaveBeenCalledTimes(1);
    // The next press is a new save request. The job already runs, so no second one starts, and the page is told so.
    await saveFromHotkey(w.deps, TAB);
    expect(w.started()).toHaveLength(1);
    expect(w.toasts().at(-1)).toEqual(["started", "Already in progress"]);
    // Pressing again and again changes nothing.
    await saveFromHotkey(w.deps, TAB);
    expect(w.started()).toHaveLength(1);
    expect(w.router.activeJobs(TAB).size).toBe(1);
  });

  it("says to reload a page whose content script cannot be reached, and saves nothing", async () => {
    const w = world({ reachable: false, frames: [] }, undefined, { localFallback: vi.fn(async () => localJob()) });
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts()).toEqual([["failed", "Reload this page so savemedia can see it."]]);
    expect(w.deps.localFallback).not.toHaveBeenCalled();
  });

  it("on a page it cannot read, saves nothing even when a request of the page was already seen, and hands the explanation to the toolbar", async () => {
    const showUnreachable = vi.fn();
    const w = world({ reachable: false, frames: [] }, undefined, { localFallback: vi.fn(async () => localJob()), showUnreachable });
    // The network capture found a file before the page could be read (a tab that was open before the install).
    await w.deps.probe(TAB, { url: "https://cdn.test/seen.mp4", frameId: 0, documentId: null, frameUrl: PAGE, scope: "page", via: "declared", retry: false }, false);
    expect(w.router.descriptors(TAB)).toHaveLength(1);
    await saveFromHotkey(w.deps, TAB);
    expect(showUnreachable).toHaveBeenCalledExactlyOnceWith(TAB);
    expect(w.started()).toEqual([]);
    expect(w.toasts()).toEqual([]);
    expect(w.deps.localFallback).not.toHaveBeenCalled();
  });

  it("reports a failure to start instead of doing nothing", async () => {
    const w = world(facts(frame(0)), undefined, { collect: vi.fn(async () => { throw new Error("tab closed"); }) });
    await saveFromHotkey(w.deps, TAB);
    expect(w.toasts()).toEqual([["failed", "Couldn't start the save. Try again."]]);
  });

  it("recognises the Alt+S shortcut as the browser reports it, and nothing else", () => {
    for (const shortcut of ["Alt+S", "⌥S", "Alt + S", "alt+s"]) expect(isAltSShortcut(shortcut), shortcut).toBe(true);
    for (const shortcut of ["", undefined, "Ctrl+S", "Ctrl+Shift+S", "⌘S", "Alt+Shift+S", "Alt+D"]) expect(isAltSShortcut(shortcut), String(shortcut)).toBe(false);
  });
});

describe("scanning a tab", () => {
  const declared = group("g", [["https://cdn.test/low.mp4", 480], ["https://cdn.test/high.mp4", 720]]);
  const main = player("v1", "https://cdn.test/low.mp4", { groups: [declared], box: { x: 0, y: 0, width: 960, height: 540 } });
  const others = [1, 2, 3, 4].map(n => player(`o${n}`, `https://cdn.test/other-${n}.mp4`, { box: { x: 0, y: 600 + n, width: 100, height: 60 } }));

  it("checks the main player's declared renditions, and the other players' sources only when the popup lists the page", async () => {
    const quiet = world(facts(frame(0, { elements: [main, ...others] })));
    const hotkey = await scanTab(quiet.deps, TAB, { pointer: false, thumbnails: false, retryFailed: false, list: false });
    expect(quiet.probes.map(request => request.url)).toEqual(["https://cdn.test/low.mp4", "https://cdn.test/high.mp4"]);
    expect(hotkey.selection).toMatchObject({ state: "ready", toProbe: [] });
    expect(hotkey.selection.candidates).toHaveLength(2);

    const listing = world(facts(frame(0, { elements: [main, ...others] })));
    const popup = await scanTab(listing.deps, TAB, { pointer: false, thumbnails: true, retryFailed: false, list: true });
    expect(listing.probes).toHaveLength(6);
    expect(popup.selection.cards).toHaveLength(5);
    expect(popup.selection.listProbe).toEqual([]);
    expect(listing.deps.collect).toHaveBeenCalledWith(TAB, { pointer: false, thumbnails: true });
  });

  it("is idempotent: a second scan of the same page state asks for nothing and selects the same", async () => {
    const w = world(facts(frame(0, { elements: [main, ...others] })));
    const options = { pointer: false, thumbnails: false, retryFailed: false, list: true };
    const first = await scanTab(w.deps, TAB, options);
    const requests = w.fetchFn.mock.calls.length;
    const second = await scanTab(w.deps, TAB, options);
    expect(w.fetchFn).toHaveBeenCalledTimes(requests);
    expect(second.selection).toEqual(first.selection);
    expect(w.router.descriptors(TAB)).toHaveLength(6);
  });

  it("checks a failed source again only when the user asked to", async () => {
    const w = world(facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] })), async () => response("text/html", "busy", 404));
    const options = { pointer: false, thumbnails: false, list: true };
    await scanTab(w.deps, TAB, { ...options, retryFailed: false });
    const requests = w.fetchFn.mock.calls.length;
    const again = await scanTab(w.deps, TAB, { ...options, retryFailed: false });
    expect(w.fetchFn).toHaveBeenCalledTimes(requests);
    expect(again.selection.state).toBe("failed");
    await scanTab(w.deps, TAB, { ...options, retryFailed: true });
    expect(w.fetchFn.mock.calls.length).toBeGreaterThan(requests);
  });

  it("runs at most three checks at a time, in counted rounds", async () => {
    let running = 0;
    let most = 0;
    const probe = vi.fn(async () => {
      most = Math.max(most, ++running);
      await Promise.resolve();
      running--;
    });
    const w = world(facts(frame(0, { elements: [main, ...others] })), undefined, { probe });
    await scanTab(w.deps, TAB, { pointer: false, thumbnails: false, retryFailed: false, list: true });
    expect(most).toBe(3);
    // Nothing was learned, so each address was asked for exactly once.
    expect(probe).toHaveBeenCalledTimes(6);
  });
});

describe("the popup's Save on the main card", () => {
  it("starts the same selection Alt+S would, without page feedback", async () => {
    const w = world(facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] })));
    await saveFromPopup(w.deps, TAB, PAGE);
    expect(w.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/clip.mp4"]);
    expect(w.toasts()).toEqual([]);
  });

  it("tells the popup why protected media was not saved", async () => {
    const w = world(facts(frame(0)));
    w.router.addDescriptor(TAB, { ...drmDescriptor(), tabId: TAB });
    expect(await saveFromPopup(w.deps, TAB, PAGE)).toBeNull();
    expect(w.deps.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "job-failed", error: expect.objectContaining({ code: "cdm_required" }) }));
  });

  it("saves nothing for a page the tab already left, and says that the page changed", async () => {
    const left = world(facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] })));
    expect(await saveFromPopup(left.deps, TAB, "https://site.test/other")).toBe("page-changed");
    // A card of the page the popup showed that this tab no longer has is no card to save either.
    expect(await saveFromPopup(left.deps, TAB, "https://site.test/other", ["stream-gone" as never])).toBe("page-changed");
    expect(left.started()).toEqual([]);
    // Neither is the file another page names.
    const offer = { filename: "Talk 32.mov", url: "https://site.test/file/32" };
    const filePage = world(facts(frame(0, { page: { title: "Talk 32", fileDownload: offer } })));
    expect(await saveFromPopup(filePage.deps, TAB, "https://site.test/talk/31")).toBe("page-changed");
    expect(filePage.started()).toEqual([]);
  });

  it("says that the page does not answer when its own script cannot be reached, and saves nothing", async () => {
    // A request of the page was seen, but the top frame gave no facts: a tab open since before an update.
    const w = world({ reachable: false, frames: [] });
    w.router.addDescriptor(TAB, { ...direct("clip", "https://cdn.test/clip.mp4"), tabId: TAB });
    expect(await saveFromPopup(w.deps, TAB, PAGE)).toBe("unreachable");
    expect(w.started()).toEqual([]);
  });

  // A feed that advances with history.pushState, or a player that rewrites its address, while the popup is open:
  // the popup still names the address it opened on.
  it("saves the clicked card when the page changed its own address since the popup looked", async () => {
    const w = world(facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] })));
    await scanTab(w.deps, TAB, { pointer: false, thumbnails: false, retryFailed: false, list: true });
    const clip = w.router.descriptors(TAB).find(d => d.source.kind === "direct-url")!;
    expect(await saveFromPopup(w.deps, TAB, "https://site.test/watch?before=the-route-change", [clip.id])).toBeNull();
    expect(w.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/clip.mp4"]);
  });

  it("takes an address that differs only in its fragment for the same page, with or without a clicked card", async () => {
    const w = world(facts(frame(0, { elements: [player("v1", "https://cdn.test/clip.mp4")] })));
    expect(await saveFromPopup(w.deps, TAB, `${PAGE}#t=5`)).toBeNull();
    expect(w.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/clip.mp4"]);
  });

  it("gives the page's name to its only direct file when the server named none and the file's bytes are of that kind", async () => {
    const page = facts(frame(0, { elements: [player("v1", "https://site.test/signed-movie.mov?file=31")], page: { title: "Test pattern", namedFile: "Test pattern 31.mov" } }));
    const w = world(page, async () => response("video/quicktime", QUICKTIME));
    await saveFromPopup(w.deps, TAB, PAGE);
    expect(w.started()[0]?.choice?.filename).toBe("Test pattern 31.mov");
  });

  it("saves the file a page fetched whole and plays from memory, and never lists the parts a player is fed piece by piece", async () => {
    const FILE = "https://cdn.test/v/clip.mp4";
    const PART = "https://cdn.test/v/seg-1.mp4";
    const answers: Record<string, Uint8Array> = { [FILE]: WHOLE_MP4, [PART]: FRAGMENT };
    const blobPlayer = el("v1", { source: { kind: "blob", url: "blob:https://site.test/1" }, playing: true, played: true, audible: true });
    const page = facts(frame(0, { elements: [blobPlayer], pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [video("v1")] } }));
    const made = () => {
      const w = world(page, async target => response("video/mp4", answers[String(target)] ?? MP4));
      // The browser's own answers to the page's script, as network capture notes them.
      w.store.noteFetched(TAB, PART, 0, "doc-0");
      w.store.noteFetched(TAB, FILE, 0, "doc-0");
      return w;
    };
    // Alt+S over the playing video: one press checks what the document fetched and saves the whole file.
    const hotkey = made();
    await saveFromHotkey(hotkey.deps, TAB);
    expect(hotkey.probes.map(request => [request.url, request.via])).toEqual([[FILE, "fetched"], [PART, "fetched"]]);
    expect(hotkey.started().map(message => message.descriptor?.source.url)).toEqual([FILE]);
    expect(hotkey.toasts().at(-1)).toEqual(["started", "This video"]);
    // The part was looked at once and is not asked about again; the file stays listed, alone.
    expect(Object.keys(hotkey.store.tab(TAB).fetched)).toEqual([FILE]);
    expect(hotkey.router.descriptors(TAB).map(d => d.source.kind === "direct-url" ? d.source.url : null)).toEqual([FILE]);
    expect(hotkey.router.failures(TAB)).toEqual([]);
    const requests = hotkey.fetchFn.mock.calls.length;
    await scanTab(hotkey.deps, TAB, { pointer: true, thumbnails: false, retryFailed: true, list: true });
    expect(hotkey.fetchFn).toHaveBeenCalledTimes(requests);

    // The popup: the look at the page lists the file as the player's video, and Save saves it.
    const popup = made();
    const { selection } = await scanTab(popup.deps, TAB, { pointer: false, thumbnails: false, retryFailed: false, list: true });
    expect(selection).toMatchObject({ state: "ready", element: { frameId: 0, key: "v1" } });
    expect(selection.cards).toHaveLength(1);
    await saveFromPopup(popup.deps, TAB, PAGE);
    expect(popup.started().map(message => message.descriptor?.source.url)).toEqual([FILE]);

    // A page that only feeds a player piece by piece: nothing is listed, and the answer stays what it was.
    const pieces = world(page, async () => response("video/mp4", FRAGMENT));
    pieces.store.noteFetched(TAB, PART, 0, "doc-0");
    await saveFromHotkey(pieces.deps, TAB);
    expect(pieces.started()).toEqual([]);
    expect(pieces.router.descriptors(TAB)).toEqual([]);
    expect(pieces.router.failures(TAB)).toEqual([]);
    expect(pieces.toasts().at(-1)).toEqual(["no-media", HOTKEY.noMedia]);

    // Pieces whose server refuses savemedia's check (the player sent a header savemedia does not have): no piece
    // is listed as a failed source, Alt+S does not answer with a refusal for a piece the user never saw, and
    // the next press asks the server about none of them again.
    const refusedPieces = world(page, async () => ({ ...response("text/plain", "no"), status: 403 }) as never);
    for (let piece = 0; piece < 3; piece++) refusedPieces.store.noteFetched(TAB, `https://cdn.test/v/seg-${piece}.mp4`, 0, "doc-0");
    await saveFromHotkey(refusedPieces.deps, TAB);
    expect(refusedPieces.started()).toEqual([]);
    expect(refusedPieces.router.failures(TAB)).toEqual([]);
    expect(refusedPieces.toasts().at(-1)).toEqual(["no-media", HOTKEY.noMedia]);
    expect(refusedPieces.store.tab(TAB).fetched).toEqual({});
    expect(refusedPieces.store.tab(TAB).origins).toEqual({});
    const asked = refusedPieces.fetchFn.mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    await saveFromHotkey(refusedPieces.deps, TAB);
    expect(refusedPieces.fetchFn).toHaveBeenCalledTimes(asked);
    expect(refusedPieces.toasts().at(-1)).toEqual(["no-media", HOTKEY.noMedia]);
  });

  it("never gives the name of the file a page names to a preview of another kind, and Alt+S says that the named file has not arrived", async () => {
    // The page names a Matroska file and plays a short MP4 preview of it. No link to the file is declared.
    const page = facts(frame(0, { elements: [player("v1", "https://site.test/preview/9f3a.mp4", { playing: true, played: true, muted: true })],
      page: { title: "Holiday.Trip.2024.1080p.mkv", namedFile: "Holiday.Trip.2024.1080p.mkv" },
      pointer: { at: 1, x: 5, y: 5, overFrame: null, layers: [video("v1")] } }));
    const w = world(page);
    await saveFromHotkey(w.deps, TAB);
    expect(w.started()).toHaveLength(1);
    expect(w.started()[0]?.choice?.filename).toBe("9f3a.mp4");
    expect(w.toasts().at(-1)).toEqual(["started", "This video. The file this page names has not reached your browser yet."]);
    // The popup's Save saves the same preview under the same name of its own.
    const popup = world(page);
    await saveFromPopup(popup.deps, TAB, PAGE);
    expect(popup.started()[0]?.choice?.filename).toBe("9f3a.mp4");
  });

  it("saves the card the user clicked, also when the page has moved on to another video since", async () => {
    // The popup showed post 1 as the main video. By the time Save is clicked, the feed plays post 2.
    const feed = facts(frame(0, { elements: [player("v1", "https://cdn.test/post1.mp4", { render: "offscreen" }),
      player("v2", "https://cdn.test/post2.mp4", { playing: true, played: true, audible: true })] }));
    const w = world(feed);
    await scanTab(w.deps, TAB, { pointer: false, thumbnails: false, retryFailed: false, list: true });
    const post1 = w.router.descriptors(TAB).find(d => d.source.kind === "direct-url" && d.source.url.endsWith("post1.mp4"))!;
    await saveFromPopup(w.deps, TAB, PAGE, [post1.id]);
    expect(w.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/post1.mp4"]);
    // A card that is gone falls back to what the page shows now.
    const again = world(feed);
    await saveFromPopup(again.deps, TAB, PAGE, ["stream-gone" as never]);
    expect(again.started().map(message => message.descriptor?.source.url)).toEqual(["https://cdn.test/post2.mp4"]);
  });
});
