// @vitest-environment-options {"url":"https://site.example/watch"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectFrameFacts, type CollectOptions } from "../../../src/content/frame-facts";
import { framePath, renderState } from "../../../src/content/geometry";
import { elementKeys, shadowRootOf, walkMedia } from "../../../src/content/media-tree";
import { parseFrameFacts } from "../../../src/types/messages";
import { box, installCheckVisibility, playback, stackAt, viewport } from "./dom-helpers";

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

function collect(over: Partial<CollectOptions> = {}) {
  const keyOf = over.keyOf ?? elementKeys();
  const facts = collectFrameFacts(document, { pointer: false, thumbnails: false, pointerRecord: null, keyOf, keyed: new WeakMap(), fileSaveProblem: null, ...over });
  return { facts, keyOf, of: (selector: string) => facts.elements.find(element => element.key === keyOf($(selector)))! };
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  installCheckVisibility();
  viewport(1000, 800, 3000);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("render states", () => {
  it("does not clip a fixed mini player by the scrolled-away container it came from", () => {
    // The article's player moved into a corner box and keeps playing while its original wrapper is far above the viewport.
    document.body.innerHTML = `<div id="wrap" style="overflow-x:hidden; overflow-y:hidden"><video id="mini" style="position:fixed"></video>
      <video id="inline"></video></div>
      <div id="moved" style="overflow-x:hidden; overflow-y:hidden; transform:translateX(0)"><video id="held" style="position:fixed"></video></div>
      <div id="outer" style="overflow-x:hidden; overflow-y:hidden"><div id="plain"><video id="abs" style="position:absolute"></video></div></div>
      <div id="rel" style="overflow-x:hidden; overflow-y:hidden; position:relative"><video id="absin" style="position:absolute"></video></div>`;
    box($("#wrap"), 0, -900, 800, 450);
    box($("#mini"), 680, 600, 300, 170);
    box($("#inline"), 0, -900, 800, 450);
    box($("#moved"), 0, -900, 800, 450);
    box($("#held"), 680, 600, 300, 170);
    box($("#outer"), 0, -900, 800, 450);
    box($("#abs"), 0, 100, 300, 170);
    box($("#rel"), 0, -900, 800, 450);
    box($("#absin"), 0, 100, 300, 170);
    expect(renderState($("#mini"), window)).toMatchObject({ render: "visible", visible: { x: 680, y: 600, width: 300, height: 170 } });
    // A video laid out inside the wrapper is clipped by it.
    expect(renderState($("#inline"), window).visible).toBeNull();
    // A transformed ancestor holds its fixed descendants: its overflow clips them.
    expect(renderState($("#held"), window)).toMatchObject({ render: "offscreen", visible: null });
    // An absolutely positioned box is clipped only from its containing block outwards.
    expect(renderState($("#abs"), window)).toMatchObject({ render: "visible" });
    expect(renderState($("#absin"), window)).toMatchObject({ render: "offscreen" });
  });

  it("keeps a frame's facts within their bounds, so one long value does not lose the frame", () => {
    document.head.innerHTML = `<meta property="og:title" content="${"T".repeat(5000)}">`;
    document.body.innerHTML = `<video id="v" src="/clip.mp4"></video><img id="big" src="data:image/png;base64,${"A".repeat(2_100_000)}"><img id="small" src="/small.png">`;
    box($("#v"), 0, 0, 640, 360);
    stackAt(document, $("#big"), $("#small"));
    const { facts } = collect({ pointer: true, pointerRecord: { x: 5, y: 5, at: 1, overFrame: null } });
    expect(facts.page?.title).toHaveLength(2000);
    expect(facts.pointer?.layers.filter(layer => layer.kind === "image").map(layer => layer.kind === "image" && layer.url)).toEqual(["https://site.example/small.png"]);
    expect(parseFrameFacts(JSON.parse(JSON.stringify(facts)))).not.toBeNull();
  });

  it("tells visible, out of view and not rendered apart from geometry alone", () => {
    document.body.innerHTML = `<video id="shown"></video><video id="below"></video><video id="none" style="display:none"></video>
      <video id="clear" style="opacity:0"></video><video id="dot"></video><video id="beyond"></video>
      <div id="clip" style="overflow-x:hidden; overflow-y:hidden"><video id="clipped"></video></div>`;
    box($("#shown"), 0, 0, 640, 360);
    box($("#below"), 0, 1500, 640, 360);
    box($("#none"), 0, 0, 0, 0);
    box($("#clear"), 0, 0, 640, 360);
    box($("#dot"), 0, 0, 1, 1);
    box($("#beyond"), -5000, 0, 640, 360);
    box($("#clip"), 0, 400, 200, 100);
    box($("#clipped"), 0, 400, 640, 360);
    const state = (id: string) => renderState($(id), window);
    expect(state("#shown")).toMatchObject({ render: "visible", visible: { x: 0, y: 0, width: 640, height: 360 } });
    expect(state("#below")).toMatchObject({ render: "offscreen", visible: null });
    for (const id of ["#none", "#clear", "#dot", "#beyond"]) expect(state(id).render, id).toBe("hidden");
    expect(state("#clipped")).toMatchObject({ render: "visible", visible: { x: 0, y: 400, width: 200, height: 100 } });
  });

  it("the top window's frame path is empty", () => {
    expect(framePath(window)).toEqual([]);
  });
});

describe("walking a document with its shadow trees", () => {
  it("finds videos and canvases in open roots, and in closed roots of custom elements through the extension's DOM API", () => {
    document.body.innerHTML = `<video id="light"></video><x-open></x-open><x-closed></x-closed><div id="builtin"></div>`;
    $("x-open").attachShadow({ mode: "open" }).innerHTML = `<video id="open"></video><canvas></canvas>`;
    const closed = $("x-closed").attachShadow({ mode: "closed" });
    closed.innerHTML = `<video id="closed"></video>`;
    const builtin = $("#builtin").attachShadow({ mode: "closed" });
    builtin.innerHTML = `<video id="builtin-video"></video>`;
    const open = vi.fn((element: HTMLElement) => element.localName === "x-closed" ? closed : element.id === "builtin" ? builtin : null);
    (globalThis as unknown as { chrome: { dom?: unknown } }).chrome.dom = { openOrClosedShadowRoot: open };
    const tree = walkMedia(document);
    expect(tree.videos.map(video => video.id)).toEqual(["light", "open", "closed"]);
    expect(tree.canvases).toHaveLength(1);
    expect(tree.roots).toHaveLength(2);
    // Closed roots are asked for only on custom elements.
    expect(open.mock.calls.map(call => call[0].localName)).toEqual(["x-closed"]);
    expect(shadowRootOf($("#builtin"))).toBeNull();
  });
});

describe("a frame's facts", () => {
  it("states each video's source kind", () => {
    document.body.innerHTML = `<video id="file" src="/clip.mp4#t=3"></video><video id="listed"><source src="/listed.webm"></video>
      <video id="blob"></video><video id="mse"></video><video id="none"></video>`;
    playback($("#blob"), { currentSrc: "blob:https://site.example/1" });
    Object.defineProperty($("#mse"), "srcObject", { configurable: true, value: {} });
    const { of } = collect();
    expect(of("#file").source).toEqual({ kind: "url", url: "https://site.example/clip.mp4" });
    expect(of("#listed").source).toEqual({ kind: "url", url: "https://site.example/listed.webm" });
    expect(of("#blob").source).toEqual({ kind: "blob", url: "blob:https://site.example/1" });
    expect(of("#mse").source).toEqual({ kind: "media-source" });
    expect(of("#none").source).toEqual({ kind: "none" });
  });

  it("defines playing, played, audible and muted from the element's own state, and a live stream by its endless duration", () => {
    document.body.innerHTML = `<video id="idle"></video><video id="sound"></video><video id="mutedplay"></video><video id="paused"></video><video id="live"></video>`;
    playback($("#idle"), { paused: true, currentTime: 0, duration: NaN, muted: false, volume: 1 });
    playback($("#sound"), { paused: false, ended: false, readyState: 4, currentTime: 5, duration: 90, muted: false, volume: 0.8 });
    playback($("#mutedplay"), { paused: false, ended: false, readyState: 4, currentTime: 5, duration: 30, muted: true, volume: 1 });
    playback($("#paused"), { paused: true, currentTime: 192, duration: 600, muted: false, volume: 0 });
    playback($("#live"), { paused: false, ended: false, readyState: 4, currentTime: 9, duration: Infinity, muted: false, volume: 1 });
    const { of } = collect();
    expect(of("#idle")).toMatchObject({ playing: false, played: false, audible: false, muted: false, duration: null, live: false });
    expect(of("#sound")).toMatchObject({ playing: true, played: true, audible: true, muted: false, duration: 90 });
    expect(of("#mutedplay")).toMatchObject({ playing: true, played: true, audible: false, muted: true });
    expect(of("#paused")).toMatchObject({ playing: false, played: true, audible: false, muted: true, duration: 600 });
    expect(of("#live")).toMatchObject({ live: true, duration: null });
  });

  it("marks an element as keyed only from recorded key use, never from attached keys", () => {
    document.body.innerHTML = `<video id="clear"></video><video id="keyed"></video>`;
    Object.defineProperty($("#clear"), "mediaKeys", { configurable: true, value: {} });
    const keyed = new WeakMap<Element, string | null>([[$("#keyed"), "com.widevine.alpha"]]);
    const { of } = collect({ keyed });
    expect(of("#clear").keyed).toBeNull();
    expect(of("#keyed").keyed).toEqual({ keySystem: "com.widevine.alpha" });
  });

  it("counts a hidden video as feeding a canvas when the canvas contains it or it has played, and not otherwise", () => {
    document.body.innerHTML = `<div><video id="played" style="display:none"></video><canvas id="mirror"></canvas></div>
      <div><video id="preview" style="display:none"></video><canvas id="chart"></canvas></div>
      <canvas id="holder"><video id="child"></video></canvas>`;
    for (const id of ["#mirror", "#chart", "#holder"]) box($(id), 0, 0, 400, 300);
    playback($("#played"), { paused: true, currentTime: 4 });
    playback($("#preview"), { paused: true, currentTime: 0 });
    playback($("#child"), { paused: true, currentTime: 0 });
    const { of } = collect();
    expect(of("#played")).toMatchObject({ render: "hidden", canvas: { x: 0, y: 0, width: 400, height: 300 } });
    expect(of("#preview").canvas).toBeNull();
    expect(of("#child").canvas).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("gives declarations only to eligible videos: a hidden preview that never played claims nothing", () => {
    document.body.innerHTML = `<video id="shown" src="/shown.mp4"></video><video id="hidden" src="/hidden.mp4" style="display:none"></video>`;
    box($("#shown"), 0, 0, 640, 360);
    const { of } = collect();
    expect(of("#shown").groups).toHaveLength(1);
    expect(of("#hidden").groups).toEqual([]);
  });

  it("takes thumbnails only when asked, and never offers a poster address as one", () => {
    // A poster can be any address, a router's or a bank's: the popup would request it with the user's cookies.
    document.body.innerHTML = `<video id="v" src="/clip.mp4" poster="http://192.168.1.1/apply.cgi?action=reboot"></video>
      <video id="w" src="/b.mp4" poster="/poster.jpg"></video>`;
    box($("#v"), 0, 0, 640, 360);
    box($("#w"), 0, 400, 640, 360);
    expect(collect().of("#v")).not.toHaveProperty("thumbnail");
    expect(collect({ thumbnails: true }).of("#v").thumbnail).toBeNull();
    expect(collect({ thumbnails: true }).of("#w").thumbnail).toBeNull();
    document.body.innerHTML = `<video id="v" src="/clip.mp4" poster="/poster.jpg"></video>`;
    box($("#v"), 0, 0, 640, 360);
    expect(collect().of("#v").poster).toBe("https://site.example/poster.jpg");
  });

  it("reports the page's file state in the top frame, and the pointer only when asked and recorded", () => {
    document.body.innerHTML = `<h1>Clip 31.mov</h1><a href="/get/31" download>Get</a><video id="v"></video>`;
    vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    box($("#v"), 0, 0, 640, 360);
    stackAt(document, $("#v"));
    const record = { x: 10, y: 10, at: 123, overFrame: null };
    const { facts, keyOf } = collect({ pointer: true, pointerRecord: record });
    expect(facts).toMatchObject({ url: "https://site.example/watch", top: true, path: [], viewport: { width: 1000, height: 800 }, childFrames: [],
      page: { fileDownload: { filename: "Clip 31.mov", url: "https://site.example/get/31" }, fileSaveProblem: null } });
    expect(facts.pointer).toEqual({ at: 123, x: 10, y: 10, overFrame: null, layers: [{ kind: "video", key: keyOf($("#v")), via: "stack" }] });
    expect(collect({ pointerRecord: record }).facts.pointer).toBeNull();
    expect(collect({ pointer: true }).facts.pointer).toBeNull();
  });

  it("answers with facts the background's validation accepts, and gives an element the same key on every collection", () => {
    document.body.innerHTML = `<div data-setup='{"sources":[{"src":"/hls/master.m3u8","type":"application/x-mpegURL"}]}'><video id="v"></video></div>`;
    box($("#v"), 0, 0, 640, 360);
    const keyOf = elementKeys();
    const first = collect({ keyOf }).facts;
    const second = collect({ keyOf }).facts;
    expect(second).toEqual(first);
    expect(parseFrameFacts(JSON.parse(JSON.stringify(first)))).toEqual(JSON.parse(JSON.stringify(first)));
    expect(parseFrameFacts({ ...first, elements: Array.from({ length: 1001 }, () => first.elements[0]) })).toBeNull();
    expect(parseFrameFacts({ url: "x" })).toBeNull();
    // A preview is a frame captured in the page, never an address the popup would have to request.
    const withPreview = (thumbnail: string) => ({ ...first, elements: [{ ...first.elements[0]!, thumbnail }] });
    expect(parseFrameFacts(withPreview("data:image/jpeg;base64,AAAA"))).not.toBeNull();
    expect(parseFrameFacts(withPreview("http://192.168.1.1/apply.cgi?action=reboot"))).toBeNull();
  });
});
