import type { CollectedFrame, TabFacts } from "../types/page-facts";
import { childOf, contains, mapPointToChild, mapPointToParent, parentOf } from "./frame-geometry";

export interface ElementRef { readonly frameId: number; readonly key: string }

export type PointerTarget =
  | { readonly kind: "element"; readonly ref: ElementRef }
  /** `loaded`: the page shows this picture in an img element (PointerLayer). */
  | { readonly kind: "image"; readonly url: string; readonly pageUrl: string; readonly loaded: boolean }
  /**
   * A canvas of this frame, and no video element that feeds it: a player that draws frames of a video it
   * never attached to the document. What that document loaded says which stream it is. `image` is the
   * picture above the canvas at the point, when there is one: a control or a badge the player draws over
   * its video. It is the target only when the document loaded no stream the canvas can stand for.
   */
  | { readonly kind: "canvas"; readonly frameId: number; readonly image: { readonly url: string; readonly pageUrl: string; readonly loaded: boolean } | null }
  /**
   * Nothing at the point stands for itself: the page decides. `still`: the pointer is on the picture the
   * page declares as its video's still, so the user points at the page's video, loaded or not.
   */
  | { readonly kind: "page"; readonly still?: true };

export interface PointerDeps {
  readonly isAdElement: (ref: ElementRef) => boolean;
  /** The eligible videos of a frame, best first. */
  readonly ranked: (frame: CollectedFrame) => readonly ElementRef[];
}

/** The frame the pointer is in: the latest record that is not over a child frame, else the latest. */
function pointerFrame(facts: TabFacts): CollectedFrame | null {
  const withPointer = facts.frames.filter(frame => frame.pointer !== null);
  const latest = (frames: readonly CollectedFrame[]) => [...frames].sort((a, b) => b.pointer!.at - a.pointer!.at || a.frameId - b.frameId)[0] ?? null;
  return latest(withPointer.filter(frame => frame.pointer!.overFrame === null)) ?? latest(withPointer);
}

interface Found { video: ElementRef | null; ad: ElementRef | null }

/** The videos of a frame at a point, best first: the first that is no ad, and the first ad. */
function videosAt(frame: CollectedFrame, point: { x: number; y: number }, deps: PointerDeps, found: Found): void {
  for (const ref of deps.ranked(frame)) {
    const element = frame.elements.find(candidate => candidate.key === ref.key);
    if (!element || !contains(element.visible ?? element.canvas, point)) continue;
    if (!deps.isAdElement(ref)) { found.video ??= ref; return; }
    found.ad ??= ref;
  }
}

/**
 * The video of a child frame, or of a frame inside it, at a point of the
 * parent. The child reported no pointer of its own, because something of the
 * parent lies above it, so its videos are found by where they are.
 */
function videoInChild(parent: CollectedFrame, index: number, point: { x: number; y: number }, facts: TabFacts, deps: PointerDeps, found: Found, depth = 0): void {
  const child = childOf(parent, index, facts.frames);
  const inside = child ? mapPointToChild(parent, child, point) : null;
  if (!child || !inside || depth > 16) return;
  videosAt(child, inside, deps, found);
  for (const place of child.childFrames) {
    if (found.video) return;
    videoInChild(child, place.index, inside, facts, deps, found, depth + 1);
  }
}

/**
 * What the pointer is on. A video anywhere at the point beats an image
 * there, also across frames: players draw posters, buttons and banners above
 * the video. A canvas stands for the video that feeds it, whether that video
 * is an element of the document or not: a canvas without a findable video is
 * named as such, together with the image above it, and the caller takes the
 * stream the canvas draws before that image. An image below a canvas is not
 * what the user sees at the point and is never the target.
 */
export function resolvePointer(facts: TabFacts, deps: PointerDeps): PointerTarget {
  const frame = pointerFrame(facts);
  if (!frame?.pointer) return { kind: "page" };
  const has = (key: string) => frame.elements.some(element => element.key === key);
  const at = { x: frame.pointer.x, y: frame.pointer.y };
  let ad: ElementRef | null = null;
  /** A canvas at the point whose video is no element of the document. */
  let bareCanvas = false;

  for (const layer of frame.pointer.layers) {
    if (layer.kind === "video" && has(layer.key)) {
      const ref = { frameId: frame.frameId, key: layer.key };
      if (!deps.isAdElement(ref)) return { kind: "element", ref };
      ad ??= ref;
    } else if (layer.kind === "frame") {
      // A banner, a click layer or an ad of this frame lies above an embedded player.
      const found: Found = { video: null, ad: null };
      videoInChild(frame, layer.index, at, facts, deps, found);
      if (found.video) return { kind: "element", ref: found.video };
      ad ??= found.ad;
    } else if (layer.kind === "canvas") {
      if (layer.feed.kind === "element" && has(layer.feed.key)) return { kind: "element", ref: { frameId: frame.frameId, key: layer.feed.key } };
      // Several videos play below this canvas: which one it draws cannot be told.
      if (layer.feed.kind === "several-playing") return { kind: "page" };
      bareCanvas = true;
    }
  }

  // A frame can lie above a video of a frame further out: a banner over a player.
  let point: { x: number; y: number } | null = at;
  for (let child = frame, parent = parentOf(child, facts.frames); parent && point; child = parent, parent = parentOf(child, facts.frames)) {
    point = mapPointToParent(child, parent, point);
    if (!point) break;
    const found: Found = { video: null, ad: null };
    videosAt(parent, point, deps, found);
    if (found.video) return { kind: "element", ref: found.video };
    ad ??= found.ad;
  }
  if (ad) return { kind: "element", ref: ad };

  const images = frame.pointer.layers.filter(layer => layer.kind === "image").filter(layer => !layer.belowCanvas);
  const image = images.find(layer => !layer.decorative) ?? images[0];
  if (image?.posterOf && has(image.posterOf)) return { kind: "element", ref: { frameId: frame.frameId, key: image.posterOf } };
  const picture = image && !image.declaredThumbnail ? { url: image.url, pageUrl: frame.url, loaded: image.loaded } : null;
  if (bareCanvas) return { kind: "canvas", frameId: frame.frameId, image: picture };
  if (picture) return { kind: "image", ...picture };
  return image?.declaredThumbnail ? { kind: "page", still: true } : { kind: "page" };
}
