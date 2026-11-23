import { vi } from "vitest";

/** jsdom lays nothing out: give an element the box a browser would. */
export function box(element: Element, x: number, y: number, width: number, height: number): void {
  const rect = { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) } as DOMRect;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
  Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
}

/** checkVisibility as a browser answers it, from computed styles up the tree. */
export function installCheckVisibility(): void {
  (Element.prototype as Element & { checkVisibility?: () => boolean }).checkVisibility = function (this: Element): boolean {
    for (let node: Element | null = this; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || (node as HTMLElement).hidden) return false;
    }
    return true;
  };
}

export function viewport(width: number, height: number, scrollHeight = height): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(document.documentElement, "scrollWidth", { configurable: true, value: width });
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: scrollHeight });
}

/** The hit stack at any point, top first. */
export function stackAt(root: Document | ShadowRoot, ...elements: Element[]): void {
  (root as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => elements;
}

/** A video in the state a player would have it. jsdom media elements never play. */
export function playback(video: HTMLVideoElement, state: { paused?: boolean; ended?: boolean; currentTime?: number; readyState?: number; duration?: number;
  muted?: boolean; volume?: number; videoWidth?: number; videoHeight?: number; currentSrc?: string }): void {
  for (const [name, value] of Object.entries(state)) Object.defineProperty(video, name, { configurable: true, value });
}
