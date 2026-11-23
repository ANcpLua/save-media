import { describe, expect, it } from "vitest";
import { resolvePointer } from "../../../src/selection/pointer-target";
import type { CollectedFrame, PointerLayer } from "../../../src/types/page-facts";
import { el, facts, frame, image, video } from "./helpers";

const at = (layers: PointerLayer[], over: Partial<NonNullable<CollectedFrame["pointer"]>> = {}) => ({ at: 100, x: 50, y: 50, overFrame: null, layers, ...over });
const deps = (ads: string[] = []) => ({
  isAdElement: (ref: { key: string }) => ads.includes(ref.key),
  ranked: (item: CollectedFrame) => item.elements.map(element => ({ frameId: item.frameId, key: element.key })),
});

describe("what the pointer is on", () => {
  it("finds the video under a click layer and under a play button image", () => {
    const page = frame(0, { elements: [el("v1")], pointer: at([image("https://site.test/play.png"), { kind: "video", key: "v1", via: "geometry" }]) });
    expect(resolvePointer(facts(page), deps())).toEqual({ kind: "element", ref: { frameId: 0, key: "v1" } });
  });

  it("takes the content video below an ad video at the same point, and the ad only when nothing else is there", () => {
    const page = frame(0, { elements: [el("ad"), el("content")], pointer: at([video("ad"), video("content")]) });
    expect(resolvePointer(facts(page), deps(["ad"]))).toEqual({ kind: "element", ref: { frameId: 0, key: "content" } });
    const only = frame(0, { elements: [el("ad")], pointer: at([video("ad")]) });
    expect(resolvePointer(facts(only), deps(["ad"]))).toEqual({ kind: "element", ref: { frameId: 0, key: "ad" } });
  });

  it("looks through a banner frame at the player of the page around it", () => {
    const top = frame(0, { elements: [el("v1", { box: { x: 0, y: 0, width: 640, height: 360 } })],
      childFrames: [{ index: 0, box: { x: 0, y: 270, width: 640, height: 90 }, visible: { x: 0, y: 270, width: 640, height: 90 } }],
      pointer: at([{ kind: "frame", index: 0 }], { at: 90, x: 300, y: 300, overFrame: 0 }) });
    const banner = frame(4, { path: [0], viewport: { width: 640, height: 90 }, pointer: at([image("https://ads.test/banner.png")], { at: 100, x: 300, y: 30 }) });
    expect(resolvePointer(facts(top, banner), deps())).toEqual({ kind: "element", ref: { frameId: 0, key: "v1" } });
  });

  it("looks below a banner, a fake play image or an ad of the page at the player in an embedded frame", () => {
    const place = { index: 0, box: { x: 0, y: 0, width: 640, height: 360 }, visible: { x: 0, y: 0, width: 640, height: 360 } };
    const player = frame(1, { path: [0], viewport: { width: 640, height: 360 }, elements: [el("clip")] });
    // The pointer is on the page's own banner image, so the frame below never saw it.
    const banner = frame(0, { childFrames: [place], pointer: at([image("https://ads.test/banner.png"), { kind: "frame", index: 0 }], { x: 320, y: 315 }) });
    expect(resolvePointer(facts(banner, player), deps())).toEqual({ kind: "element", ref: { frameId: 1, key: "clip" } });
    // An ad video of the page over the frame: the frame's content video wins, as it does inside one frame.
    const outstream = frame(0, { childFrames: [place], elements: [el("ad", { box: { x: 240, y: 270, width: 160, height: 90 } })],
      pointer: at([video("ad"), { kind: "frame", index: 0 }], { x: 320, y: 315 }) });
    expect(resolvePointer(facts(outstream, player), deps(["ad"]))).toEqual({ kind: "element", ref: { frameId: 1, key: "clip" } });
    // The player sits in a frame inside the frame.
    const shell = frame(1, { path: [0], viewport: { width: 640, height: 360 }, childFrames: [place] });
    const nested = frame(2, { path: [0, 0], viewport: { width: 640, height: 360 }, elements: [el("deep")] });
    expect(resolvePointer(facts(banner, shell, nested), deps())).toEqual({ kind: "element", ref: { frameId: 2, key: "deep" } });
    // Outside the frame's video, or with a frame that reported nothing, the banner is what the pointer is on.
    const small = frame(1, { path: [0], viewport: { width: 640, height: 360 }, elements: [el("clip", { box: { x: 0, y: 0, width: 100, height: 100 } })] });
    expect(resolvePointer(facts(banner, small), deps())).toMatchObject({ kind: "image", url: "https://ads.test/banner.png" });
    expect(resolvePointer(facts(banner), deps())).toMatchObject({ kind: "image" });
  });

  it("maps the point into a scaled frame", () => {
    const place = { index: 0, box: { x: 100, y: 100, width: 320, height: 180 }, visible: { x: 100, y: 100, width: 320, height: 180 } };
    // The frame's own viewport is 640 wide and shown at half size: its video in the right half is under a point right of the middle.
    const player = frame(1, { path: [0], viewport: { width: 640, height: 360 }, elements: [el("right", { box: { x: 320, y: 0, width: 320, height: 360 } })] });
    const over = (x: number) => frame(0, { childFrames: [place], pointer: at([image("https://site.test/layer.png"), { kind: "frame", index: 0 }], { x, y: 150 }) });
    expect(resolvePointer(facts(over(300), player), deps())).toEqual({ kind: "element", ref: { frameId: 1, key: "right" } });
    expect(resolvePointer(facts(over(200), player), deps())).toMatchObject({ kind: "image" });
  });

  it("uses the frame the pointer is in, not a frame that only saw it pass into a child", () => {
    const top = frame(0, { elements: [el("outer")], pointer: at([video("outer")], { at: 200, overFrame: 0 }) });
    const inner = frame(3, { elements: [el("inner")], pointer: at([video("inner")], { at: 150 }) });
    expect(resolvePointer(facts(top, inner), deps())).toEqual({ kind: "element", ref: { frameId: 3, key: "inner" } });
  });

  it("lets a canvas stand for the video that feeds it", () => {
    const fed = frame(0, { elements: [el("v1", { render: "hidden" })], pointer: at([{ kind: "canvas", feed: { kind: "element", key: "v1" } }]) });
    expect(resolvePointer(facts(fed), deps())).toEqual({ kind: "element", ref: { frameId: 0, key: "v1" } });
  });

  it("does not guess between several playing videos below a canvas: the page decides", () => {
    const several = frame(0, { elements: [el("v1"), el("v2")], pointer: at([{ kind: "canvas", feed: { kind: "several-playing" } }, video("v2")]) });
    expect(resolvePointer(facts(several), deps())).toEqual({ kind: "page" });
  });

  it("skips a canvas without a video and examines the next layer for a video", () => {
    const chart = frame(0, { elements: [el("v1")], pointer: at([{ kind: "canvas", feed: { kind: "none" } }, video("v1")]) });
    expect(resolvePointer(facts(chart), deps())).toEqual({ kind: "element", ref: { frameId: 0, key: "v1" } });
  });

  it("never takes an image below a canvas: the canvas is what the user sees there", () => {
    const chart = frame(0, { pointer: at([{ kind: "canvas", feed: { kind: "none" } }, image("https://site.test/photo.png", { belowCanvas: true })]) });
    expect(resolvePointer(facts(chart), deps())).toEqual({ kind: "canvas", frameId: 0, image: null });
  });

  it("names a canvas whose video is no element of the document, in the frame the pointer is in, when nothing else at the point is a target", () => {
    const bare = frame(0, { pointer: at([{ kind: "canvas", feed: { kind: "none" } }]) });
    expect(resolvePointer(facts(bare), deps())).toEqual({ kind: "canvas", frameId: 0, image: null });
    // A canvas in an embedded player is that frame's canvas.
    const top = frame(0, { elements: [], pointer: at([{ kind: "frame", index: 0 }], { at: 100, overFrame: 0 }) });
    const inner = frame(4, { pointer: at([{ kind: "canvas", feed: { kind: "none" } }], { at: 100 }) });
    expect(resolvePointer(facts(top, inner), deps())).toEqual({ kind: "canvas", frameId: 4, image: null });
    // A canvas whose feed is named but is no known element is the same case.
    const stale = frame(0, { pointer: at([{ kind: "canvas", feed: { kind: "element", key: "gone" } }]) });
    expect(resolvePointer(facts(stale), deps())).toEqual({ kind: "canvas", frameId: 0, image: null });
    // An image above the canvas travels with the canvas: a player draws its controls there, and a chart its badges.
    // Which of the two is saved is decided where the document's streams are known (main-video.ts).
    const card = { url: "https://site.test/card.png", pageUrl: "https://site.test/watch", loaded: false };
    const badge = frame(0, { pointer: at([image("https://site.test/card.png"), { kind: "canvas", feed: { kind: "none" } }]) });
    expect(resolvePointer(facts(badge), deps())).toEqual({ kind: "canvas", frameId: 0, image: card });
    // A decorative icon above the canvas is still the picture at the point, and a photo above it comes first.
    const control = frame(0, { pointer: at([image("https://site.test/ui/big-play.png", { decorative: true }), { kind: "canvas", feed: { kind: "none" } }]) });
    expect(resolvePointer(facts(control), deps())).toEqual({ kind: "canvas", frameId: 0, image: { ...card, url: "https://site.test/ui/big-play.png" } });
    // A canvas whose video is an element of the document stands for that video, whatever lies above it.
    const fed = frame(0, { elements: [el("v1")], pointer: at([image("https://site.test/ui/big-play.png", { decorative: true }), { kind: "canvas", feed: { kind: "element", key: "v1" } }]) });
    expect(resolvePointer(facts(fed), deps())).toEqual({ kind: "element", ref: { frameId: 0, key: "v1" } });
    // A thumbnail the page declares for its video is never saved as a picture, also above a canvas.
    const thumb = frame(0, { pointer: at([image("https://site.test/thumb.jpg", { declaredThumbnail: true }), { kind: "canvas", feed: { kind: "none" } }]) });
    expect(resolvePointer(facts(thumb), deps())).toEqual({ kind: "canvas", frameId: 0, image: null });
    // Without a canvas at the point, the page decides.
    expect(resolvePointer(facts(frame(0, { pointer: at([]) })), deps())).toEqual({ kind: "page" });
  });

  it("resolves a poster to its video and a declared thumbnail to the page's video", () => {
    const poster = frame(0, { elements: [el("v1")], pointer: at([image("https://site.test/poster.jpg", { posterOf: "v1" })]) });
    expect(resolvePointer(facts(poster), deps())).toEqual({ kind: "element", ref: { frameId: 0, key: "v1" } });
    // The target says that the user points at the video's still: with nothing loaded, the page's video has not loaded yet.
    const thumb = frame(0, { pointer: at([image("https://site.test/thumb.jpg", { declaredThumbnail: true })]) });
    expect(resolvePointer(facts(thumb), deps())).toEqual({ kind: "page", still: true });
    // A picture of its own above the still is what the pointer is on.
    const badge = frame(0, { pointer: at([image("https://site.test/badge.png"), image("https://site.test/thumb.jpg", { declaredThumbnail: true })]) });
    expect(resolvePointer(facts(badge), deps())).toMatchObject({ kind: "image", url: "https://site.test/badge.png" });
  });

  it("saves a lone decorative image, and the photo below a decorative icon", () => {
    const lone = frame(0, { pointer: at([image("https://site.test/photo.jpg", { decorative: true })]) });
    expect(resolvePointer(facts(lone), deps())).toEqual({ kind: "image", url: "https://site.test/photo.jpg", pageUrl: lone.url, loaded: false });
    // Whether the page shows the picture travels with the image the pointer is on.
    const shown = frame(0, { pointer: at([image("http://192.168.1.10/cam.jpg", { loaded: true })]) });
    expect(resolvePointer(facts(shown), deps())).toEqual({ kind: "image", url: "http://192.168.1.10/cam.jpg", pageUrl: shown.url, loaded: true });
    const icon = frame(0, { pointer: at([image("https://site.test/zoom.svg", { decorative: true }), image("https://site.test/photo.jpg")]) });
    expect(resolvePointer(facts(icon), deps())).toMatchObject({ kind: "image", url: "https://site.test/photo.jpg" });
  });

  it("means the page when no frame holds the pointer, or nothing is under it", () => {
    expect(resolvePointer(facts(frame(0)), deps())).toEqual({ kind: "page" });
    expect(resolvePointer(facts(frame(0, { pointer: at([]) })), deps())).toEqual({ kind: "page" });
  });
});
