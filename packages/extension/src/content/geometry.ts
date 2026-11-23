import type { ChildFrameFact, Rect } from "../types/page-facts";
import { FACT_LIMITS } from "../util/fact-limits";
import { parentAcrossShadow } from "./media-tree";

function rectOf(box: { left: number; top: number; width: number; height: number }): Rect {
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

export function intersect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function viewportOf(win: Window): Rect {
  return { x: 0, y: 0, width: win.innerWidth, height: win.innerHeight };
}

/** Whether an element is the containing block of fixed-position descendants: only then does its overflow clip them. */
function containsFixed(style: CSSStyleDeclaration): boolean {
  const set = (value: string | undefined): boolean => !!value && value !== "none" && value !== "auto" && value !== "normal";
  const extra = style as CSSStyleDeclaration & { backdropFilter?: string; containerType?: string };
  return set(style.transform) || set(style.perspective) || set(style.filter) || set(extra.backdropFilter)
    || /\b(?:layout|paint|strict|content)\b/.test(style.contain ?? "") || set(extra.containerType)
    || /\b(?:transform|perspective|filter)\b/.test(style.willChange ?? "");
}

/**
 * The part of a box that its clipping ancestors and the frame's viewport
 * leave visible. An ancestor's overflow clips only what it contains: a
 * fixed-position box (a mini player that keeps playing in a corner) is laid
 * out against the viewport, so the scrolled-away container it came from does
 * not clip it. The same holds for an absolutely positioned box and the
 * non-positioned ancestors between it and its containing block.
 */
function clipped(element: Element, box: Rect, win: Window): Rect | null {
  let visible: Rect | null = box;
  let position = win.getComputedStyle(element).position;
  for (let parent = parentAcrossShadow(element); parent && visible; parent = parentAcrossShadow(parent)) {
    if (parent === parent.ownerDocument.documentElement || parent === parent.ownerDocument.body) continue;
    const style = win.getComputedStyle(parent);
    const contains = position === "fixed" ? containsFixed(style)
      : position === "absolute" ? (style.position !== "static" && style.position !== "") || containsFixed(style) : true;
    if (!contains) continue;
    const clips = (value: string): boolean => value !== "" && value !== "visible";
    if (clips(style.overflowX) || clips(style.overflowY)) visible = intersect(visible, rectOf(parent.getBoundingClientRect()));
    position = style.position;
  }
  return intersect(visible, viewportOf(win));
}

export interface RenderState {
  readonly render: "visible" | "offscreen" | "hidden";
  readonly box: Rect;
  readonly visible: Rect | null;
}

/**
 * hidden: the page does not render the element (no layout box, invisible,
 * at most 1 px, or outside the area any scrolling can reach). offscreen:
 * rendered, but nothing of it is in view now. Measured from geometry in one
 * pass, so the same page state always gives the same answer.
 */
export function renderState(element: Element, win: Window): RenderState {
  const box = rectOf(element.getBoundingClientRect());
  const check = (element as Element & { checkVisibility?: (options: object) => boolean }).checkVisibility;
  const shown = typeof check === "function"
    ? check.call(element, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })
    : true;
  if (!shown || box.width <= 1 || box.height <= 1) return { render: "hidden", box, visible: null };
  const scroller = element.ownerDocument.scrollingElement ?? element.ownerDocument.documentElement;
  const page: Rect = { x: -win.scrollX, y: -win.scrollY,
    width: Math.max(scroller?.scrollWidth ?? 0, win.innerWidth), height: Math.max(scroller?.scrollHeight ?? 0, win.innerHeight) };
  const fixed = win.getComputedStyle(element).position === "fixed";
  if (!intersect(box, fixed ? viewportOf(win) : page)) return { render: "hidden", box, visible: null };
  const visible = clipped(element, box, win);
  return { render: visible ? "visible" : "offscreen", box, visible };
}

/** The window.frames index chain from the top window down to this one. */
export function framePath(win: Window): readonly number[] | null {
  const path: number[] = [];
  try {
    for (let current: Window = win; current !== current.top; current = current.parent) {
      const parent = current.parent;
      let index = -1;
      for (let i = 0; i < parent.length; i++) {
        if (parent[i] === current) { index = i; break; }
      }
      if (index < 0) return null;
      path.unshift(index);
    }
    return path;
  } catch { return null; }
}

/** Where each child frame's content area sits in this document. */
export function childFrames(doc: Document, win: Window): readonly ChildFrameFact[] {
  const frames: ChildFrameFact[] = [];
  const elements = [...doc.querySelectorAll<HTMLIFrameElement>("iframe, frame")];
  for (let index = 0; index < win.length && frames.length < FACT_LIMITS.childFrames; index++) {
    let child: Window;
    try { child = win[index] as unknown as Window; } catch { continue; }
    const element = elements.find(candidate => candidate.contentWindow === child);
    if (!element) continue;
    const outer = element.getBoundingClientRect();
    const style = win.getComputedStyle(element);
    const edge = (value: string) => Number.parseFloat(value) || 0;
    const left = element.clientLeft + edge(style.paddingLeft);
    const top = element.clientTop + edge(style.paddingTop);
    const box: Rect = { x: outer.left + left, y: outer.top + top,
      width: Math.max(0, element.clientWidth - edge(style.paddingLeft) - edge(style.paddingRight)),
      height: Math.max(0, element.clientHeight - edge(style.paddingTop) - edge(style.paddingBottom)) };
    const state = renderState(element, win);
    frames.push({ index, box, visible: state.render === "visible" ? intersect(box, state.visible) : null });
  }
  return frames;
}
