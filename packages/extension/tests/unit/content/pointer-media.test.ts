// @vitest-environment-options {"url":"https://site.example/watch"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasFeed, notRenderedIndex } from "../../../src/content/canvas-feed";
import { elementKeys } from "../../../src/content/media-tree";
import { pointerLayers, type PointerScan } from "../../../src/content/pointer-media";
import { box, playback, stackAt } from "./dom-helpers";

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { vi.restoreAllMocks(); });

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

function scan(over: Partial<PointerScan> = {}): PointerScan {
  const videos = [...document.querySelectorAll("video")];
  return { videos, rendered: new Set(videos), notRendered: new Map(), keyOf: elementKeys(), thumbnails: new Set(), playerStills: new Set(), frameIndex: () => null, ...over };
}

describe("the video a canvas draws", () => {
  const feed = (hidden: HTMLVideoElement[]) => canvasFeed($("canvas"), notRenderedIndex(hidden));

  it("is the video the canvas contains", () => {
    document.body.innerHTML = `<canvas><video id="inner"></video></canvas><video id="other"></video>`;
    expect(feed([])).toEqual({ kind: "element", video: $("#inner"), via: "child" });
  });

  it("is the one non-rendered video its nearest ancestor holds, playing or not", () => {
    document.body.innerHTML = `<div id="player"><video id="v" style="display:none"></video><div><canvas></canvas></div></div><video id="far" style="display:none"></video>`;
    expect(feed([$("#v"), $("#far")])).toEqual({ kind: "element", video: $("#v"), via: "ancestor" });
  });

  it("among several non-rendered videos, is the only one that has played, else the only one playing now", () => {
    document.body.innerHTML = `<div><video id="a"></video><video id="b"></video><video id="c"></video><canvas></canvas></div>`;
    const [a, b, c] = ["#a", "#b", "#c"].map(id => $<HTMLVideoElement>(id));
    playback(a!, { paused: true, currentTime: 0 });
    playback(b!, { paused: true, currentTime: 12 });
    playback(c!, { paused: true, currentTime: 0 });
    expect(feed([a!, b!, c!])).toMatchObject({ kind: "element", video: b });
    playback(a!, { paused: false, ended: false, readyState: 4, currentTime: 3 });
    expect(feed([a!, b!, c!])).toMatchObject({ kind: "element", video: a });
  });

  it("does not guess between several playing videos, and names no source when none ever played", () => {
    document.body.innerHTML = `<div><video id="a"></video><video id="b"></video><canvas></canvas></div>`;
    const [a, b] = ["#a", "#b"].map(id => $<HTMLVideoElement>(id));
    for (const video of [a!, b!]) playback(video, { paused: true, currentTime: 0 });
    expect(feed([a!, b!])).toEqual({ kind: "none" });
    for (const video of [a!, b!]) playback(video, { paused: false, ended: false, readyState: 4, currentTime: 5 });
    expect(feed([a!, b!])).toEqual({ kind: "several-playing" });
  });

  it("is none for a chart: a canvas with no video anywhere above it", () => {
    document.body.innerHTML = `<section><canvas></canvas></section>`;
    expect(feed([])).toEqual({ kind: "none" });
  });

  it("finds the video through shadow roots", () => {
    document.body.innerHTML = `<x-player></x-player>`;
    const root = $("x-player").attachShadow({ mode: "open" });
    root.innerHTML = `<video style="display:none"></video><canvas></canvas>`;
    const video = root.querySelector("video")!;
    expect(canvasFeed(root.querySelector("canvas")!, notRenderedIndex([video]))).toEqual({ kind: "element", video, via: "ancestor" });
  });
});

describe("the media layers under the pointer", () => {
  it("lists a video below a controls layer, and one that ignores the pointer by its geometry", () => {
    document.body.innerHTML = `<div class="tile"><video id="under" src="/low.mp4"></video><div class="controls"><img id="play" src="/play.png" alt="Play"></div></div>
      <video id="elsewhere" src="/other.mp4"></video>`;
    box($("#under"), 0, 0, 320, 180);
    box($("#play"), 128, 58, 64, 64);
    box($("#elsewhere"), 0, 400, 320, 180);
    stackAt(document, $("#play"), $(".controls"), $(".tile"), document.body);
    const details = scan();
    const layers = pointerLayers(document, 160, 90, details);
    expect(layers).toEqual([
      { kind: "video", key: details.keyOf($("#under")), via: "geometry" },
      { kind: "image", url: "https://site.example/play.png", decorative: false, posterOf: null, declaredThumbnail: false, belowCanvas: false, loaded: false },
    ]);
  });

  it("keeps the stack order: an ad video above a content video", () => {
    document.body.innerHTML = `<video id="content"></video><video id="ad"></video>`;
    box($("#content"), 0, 0, 640, 360);
    box($("#ad"), 0, 0, 640, 360);
    stackAt(document, $("#ad"), $("#content"));
    const details = scan();
    expect(pointerLayers(document, 10, 10, details).map(layer => layer.kind === "video" ? [layer.key, layer.via] : layer.kind))
      .toEqual([[details.keyOf($("#ad")), "stack"], [details.keyOf($("#content")), "stack"]]);
  });

  it("reports a canvas with the video that feeds it, and marks images below a canvas", () => {
    document.body.innerHTML = `<div id="player"><video id="v" style="display:none"></video><canvas id="c"></canvas></div><img id="photo" src="/photo.png" alt="Photo">`;
    box($("#photo"), 0, 0, 300, 200);
    stackAt(document, $("#c"), $("#photo"));
    const hidden = [$<HTMLVideoElement>("#v")];
    const details = scan({ rendered: new Set(), notRendered: notRenderedIndex(hidden) });
    expect(pointerLayers(document, 10, 10, details)).toEqual([
      { kind: "canvas", feed: { kind: "element", key: details.keyOf($("#v")) } },
      { kind: "image", url: "https://site.example/photo.png", decorative: false, posterOf: null, declaredThumbnail: false, belowCanvas: true, loaded: false },
    ]);
  });

  it("knows decorative images by the page's own semantics, posters by their video, and declared thumbnails", () => {
    document.body.innerHTML = `<video id="v" poster="/poster.jpg"></video><img id="poster" src="/poster.jpg" alt="Poster">
      <img id="spacer" src="/spacer.gif" alt=""><span aria-hidden="true"><img id="icon" src="/icon.svg" alt="Zoom"></span>
      <img id="role" src="/divider.png" role="presentation" alt="x"><img id="thumb" src="/thumb.jpg" alt="Still">`;
    stackAt(document, $("#poster"), $("#spacer"), $("#icon"), $("#role"), $("#thumb"));
    const details = scan({ rendered: new Set(), thumbnails: new Set(["https://site.example/thumb.jpg"]) });
    const images = pointerLayers(document, 10, 10, details).filter(layer => layer.kind === "image");
    expect(images.map(layer => [layer.url.replace("https://site.example", ""), layer.decorative, layer.posterOf, layer.declaredThumbnail])).toEqual([
      ["/poster.jpg", false, details.keyOf($("#v")), false], ["/spacer.gif", true, null, false], ["/icon.svg", true, null, false],
      ["/divider.png", true, null, false], ["/thumb.jpg", false, null, true]]);
  });

  // A page whose og:video names an embed page declares its og:image the same way whether it is a player's poster
  // or an article's lead photo. Where the picture lies says which.
  it("takes a picture that is a still only on a player for one where it overlaps a media element, and for a picture anywhere else", () => {
    const HERO = "https://site.example/hero.jpg";
    const still = (details: PointerScan): boolean[] => pointerLayers(document, 10, 10, details).flatMap(layer => layer.kind === "image" ? [layer.declaredThumbnail] : []);
    // An article: the lead photo at the top, the video further down the page.
    document.body.innerHTML = `<img id="hero" src="/hero.jpg" alt="Lead photo"><video id="v"></video>`;
    box($("#hero"), 0, 0, 640, 360);
    box($("#v"), 0, 900, 640, 360);
    stackAt(document, $("#hero"));
    expect(still(scan({ playerStills: new Set([HERO]) }))).toEqual([false]);
    // The photo next to the player, edge to edge, lies on nothing.
    box($("#v"), 640, 0, 640, 360);
    expect(still(scan({ playerStills: new Set([HERO]) }))).toEqual([false]);
    // A player that keeps its video small under its poster until it plays: the poster lies on it.
    box($("#v"), 319, 179, 2, 2);
    expect(still(scan({ rendered: new Set(), playerStills: new Set([HERO]) }))).toEqual([true]);
    // A video without a box (display: none) is nowhere, and a page without a video has no player to lie on.
    box($("#v"), 0, 0, 0, 0);
    expect(still(scan({ playerStills: new Set([HERO]) }))).toEqual([false]);
    $("#v").remove();
    expect(still(scan({ playerStills: new Set([HERO]) }))).toEqual([false]);
    // A picture the page declares as a still outright is one wherever it lies.
    expect(still(scan({ thumbnails: new Set([HERO]) }))).toEqual([true]);
    // Another picture on a player is a picture.
    document.body.innerHTML = `<img id="logo" src="/logo.png" alt="Logo"><video id="v"></video>`;
    box($("#logo"), 0, 0, 100, 40);
    box($("#v"), 0, 0, 640, 360);
    stackAt(document, $("#logo"));
    expect(still(scan({ rendered: new Set(), playerStills: new Set([HERO]) }))).toEqual([false]);
  });

  // What Alt+S on an image at a local address rests on: only a picture the browser shows counts as loaded.
  it("says an img element has loaded only when the browser shows its picture, and never says it of a background image", () => {
    document.body.innerHTML = `<img id="shown" src="http://192.168.1.10/cam.jpg" alt="Camera"><img id="broken" src="http://192.168.1.10/gone.jpg" alt="Gone">
      <img id="loading" src="http://192.168.1.10/slow.jpg" alt="Slow"><img id="aside" src="http://192.168.1.10/aside.jpg" alt="Aside">
      <div id="bg" style="background-image: url('http://192.168.1.10/bg.jpg')"></div>`;
    const state = (id: string, complete: boolean, naturalWidth: number): void => {
      Object.defineProperty($(id), "complete", { configurable: true, get: () => complete });
      Object.defineProperty($(id), "naturalWidth", { configurable: true, get: () => naturalWidth });
    };
    state("#shown", true, 640);
    // A broken image is complete and has no picture; one still loading may have a size already.
    state("#broken", true, 0);
    state("#loading", false, 640);
    state("#aside", true, 320);
    // Not in the hit stack (it ignores the pointer), found by its geometry.
    box($("#aside"), 0, 0, 300, 200);
    stackAt(document, $("#shown"), $("#broken"), $("#loading"), $("#bg"), document.body);
    const images = pointerLayers(document, 10, 10, scan()).filter(layer => layer.kind === "image");
    expect(images.map(layer => [new URL(layer.url).pathname, layer.loaded])).toEqual([
      ["/cam.jpg", true], ["/gone.jpg", false], ["/slow.jpg", false], ["/aside.jpg", true], ["/bg.jpg", false]]);
  });

  it("reads a background image, and looks into open shadow roots and frames", () => {
    document.body.innerHTML = `<div id="bg" style="background-image: url('/bg.jpg')"></div><x-player></x-player><iframe id="embed"></iframe>`;
    const root = $("x-player").attachShadow({ mode: "open" });
    root.innerHTML = `<video></video>`;
    const inner = root.querySelector("video")!;
    stackAt(root, inner);
    stackAt(document, $("x-player"), $("#embed"), $("#bg"), document.body);
    const details = scan({ videos: [inner], rendered: new Set([inner]), frameIndex: element => element.id === "embed" ? 2 : null });
    expect(pointerLayers(document, 10, 10, details)).toEqual([
      { kind: "video", key: details.keyOf(inner), via: "stack" },
      { kind: "frame", index: 2 },
      { kind: "image", url: "https://site.example/bg.jpg", decorative: false, posterOf: null, declaredThumbnail: false, belowCanvas: false, loaded: false },
    ]);
  });
});
