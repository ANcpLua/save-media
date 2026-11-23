import type { PointerLayer } from "../types/page-facts";
import { FACT_LIMITS } from "../util/fact-limits";
import { canvasFeed, type CanvasFeed } from "./canvas-feed";
import { parentAcrossShadow, shadowRootOf } from "./media-tree";

/**
 * Everything under a viewport point from the top down, through open shadow
 * roots and the closed roots of custom elements. Hit testing lists a
 * player's controls and transparent overlays above its video.
 */
export function elementsAtPoint(root: Document | ShadowRoot, x: number, y: number, seen = new Set<Element>()): Element[] {
  const found: Element[] = [];
  for (const element of root.elementsFromPoint?.(x, y) ?? []) {
    // A shadow root also reports the host's ancestors, which its document lists in order.
    if (seen.has(element) || (root !== element.ownerDocument && element.getRootNode() !== root)) continue;
    seen.add(element);
    // A shadow root is reported as its host. Its content lies above it.
    const shadow = shadowRootOf(element);
    if (shadow) found.push(...elementsAtPoint(shadow, x, y, seen));
    found.push(element);
  }
  return found;
}

function imageUrl(element: Element): string {
  const image = element as HTMLImageElement;
  return image.currentSrc || image.src || "";
}

/**
 * The img element shows its picture: the browser was answered with it and
 * decoded it. A broken image, and one still loading, has no natural width.
 */
function imageLoaded(element: Element): boolean {
  if (element.localName !== "img") return false;
  const image = element as HTMLImageElement;
  return image.complete && image.naturalWidth > 0;
}

function backgroundImage(element: Element): string | null {
  const view = element.ownerDocument.defaultView;
  const value = view?.getComputedStyle(element).backgroundImage ?? "";
  const match = /url\(\s*(["']?)(.*?)\1\s*\)/i.exec(value);
  if (!match?.[2]) return null;
  try { return new URL(match[2], element.ownerDocument.baseURI).href; } catch { return null; }
}

function covers(element: Element, x: number, y: number): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    && element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== "hidden";
}

/**
 * The element lies on a player: its box and the box of a media element of the page overlap. A poster laid
 * over a player's video does, however small the video is kept until it plays; a photo elsewhere on the
 * page does not.
 */
function onPlayer(element: Element, videos: readonly HTMLVideoElement[]): boolean {
  const box = element.getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0)) return false;
  return videos.some(video => {
    const other = video.getBoundingClientRect();
    return other.width > 0 && other.height > 0 && box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom;
  });
}

/** Decorative by the page's own semantics: empty alt text, a presentation role, or hidden from assistive technology. */
function decorative(element: Element): boolean {
  if (element.localName === "img" && element.getAttribute("alt") === "") return true;
  for (let current: Element | null = element; current; current = parentAcrossShadow(current)) {
    const role = current === element ? current.getAttribute("role") : null;
    if (role === "presentation" || role === "none" || current.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

export interface PointerScan {
  readonly videos: readonly HTMLVideoElement[];
  /** Videos the page renders (not hidden). */
  readonly rendered: ReadonlySet<HTMLVideoElement>;
  readonly notRendered: ReadonlyMap<Element, readonly HTMLVideoElement[]>;
  readonly keyOf: (element: Element) => string;
  /** Pictures the page declares as stills of its videos. */
  readonly thumbnails: ReadonlySet<string>;
  /** Pictures that are a video's still only where they lie on a player (onPlayer). */
  readonly playerStills: ReadonlySet<string>;
  readonly frameIndex: (element: Element) => number | null;
}

/**
 * The media layers at a point, top first: videos, canvases with the video
 * that feeds them, frames, and then images. Rendered videos that ignore the
 * pointer (pointer-events: none below a controls layer) follow the hit
 * stack, found by their geometry.
 */
export function pointerLayers(doc: Document, x: number, y: number, scan: PointerScan): PointerLayer[] {
  const stack = elementsAtPoint(doc, x, y);
  const layers: PointerLayer[] = [];
  const listed = new Set<Element>();
  const posters = new Map<string, string>();
  for (const video of scan.videos) {
    if (!video.poster) continue;
    try { posters.set(new URL(video.poster, doc.baseURI).href, scan.keyOf(video)); } catch { /* Not an address. */ }
  }
  for (const element of stack) {
    if (element.localName === "video") {
      layers.push({ kind: "video", key: scan.keyOf(element), via: "stack" });
      listed.add(element);
    } else if (element.localName === "canvas") {
      const feed: CanvasFeed = canvasFeed(element as HTMLCanvasElement, scan.notRendered);
      layers.push({ kind: "canvas", feed: feed.kind === "element" ? { kind: "element", key: scan.keyOf(feed.video) } : feed });
    } else if (element.localName === "iframe" || element.localName === "frame") {
      const index = scan.frameIndex(element);
      if (index !== null) layers.push({ kind: "frame", index });
    }
  }
  for (const video of scan.videos) {
    if (!listed.has(video) && scan.rendered.has(video) && covers(video, x, y)) layers.push({ kind: "video", key: scan.keyOf(video), via: "geometry" });
  }
  const images = new Map<string, { readonly element: Element; readonly loaded: boolean }>();
  // An address longer than the facts carry (a very large data: image) is left out, so the rest of the frame's facts still arrive.
  // Only an img element says that its picture has loaded; a background image names an address and no more.
  const note = (url: string | null, element: Element, loaded: boolean): void => {
    if (url && url.length <= FACT_LIMITS.imageUrl && !images.has(url)) images.set(url, { element, loaded });
  };
  for (const element of stack) if (element.localName === "img") note(imageUrl(element), element, imageLoaded(element));
  for (const element of doc.querySelectorAll("img")) {
    if (!stack.includes(element) && covers(element, x, y)) note(imageUrl(element), element, imageLoaded(element));
  }
  for (const element of stack) {
    if (element.localName !== "html" && element.localName !== "body") note(backgroundImage(element), element, false);
  }
  const topCanvas = stack.findIndex(element => element.localName === "canvas");
  for (const [url, { element, loaded }] of images) {
    const at = stack.indexOf(element);
    layers.push({ kind: "image", url, decorative: decorative(element), posterOf: posters.get(url) ?? null,
      declaredThumbnail: scan.thumbnails.has(url) || (scan.playerStills.has(url) && onPlayer(element, scan.videos)), belowCanvas: topCanvas >= 0 && (at < 0 || at > topCanvas), loaded });
  }
  return layers.slice(0, FACT_LIMITS.layers);
}
