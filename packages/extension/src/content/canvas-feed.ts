import { parentAcrossShadow, shadowRootOf } from "./media-tree";

export type CanvasFeed =
  | { readonly kind: "element"; readonly video: HTMLVideoElement; readonly via: "child" | "ancestor" }
  | { readonly kind: "several-playing" }
  | { readonly kind: "none" };

/** For every ancestor of a non-rendered video: the non-rendered videos below it. Built once per scan. */
export function notRenderedIndex(hidden: readonly HTMLVideoElement[]): Map<Element, HTMLVideoElement[]> {
  const index = new Map<Element, HTMLVideoElement[]>();
  for (const video of hidden) {
    for (let parent = parentAcrossShadow(video); parent; parent = parentAcrossShadow(parent)) {
      const list = index.get(parent);
      if (list) list.push(video);
      else index.set(parent, [video]);
    }
  }
  return index;
}

function firstVideoIn(root: Element | ShadowRoot): HTMLVideoElement | null {
  const direct = root.querySelector("video");
  if (direct) return direct;
  for (const element of root.querySelectorAll("*")) {
    const shadow = shadowRootOf(element);
    const nested = shadow ? firstVideoIn(shadow) : null;
    if (nested) return nested;
  }
  return null;
}

export const hasPlayed = (video: HTMLVideoElement): boolean => video.currentTime > 0 || !video.paused;
const playingNow = (video: HTMLVideoElement): boolean => !video.paused && !video.ended && video.readyState >= 3;

/**
 * The video a canvas draws, found without touching the canvas or the
 * drawing calls: a video the canvas contains, else the non-rendered video
 * its nearest ancestor holds. Playing only breaks ties: a paused player is
 * still a player. Several candidates that never played name no source.
 */
export function canvasFeed(canvas: HTMLCanvasElement, notRendered: ReadonlyMap<Element, readonly HTMLVideoElement[]>): CanvasFeed {
  const child = firstVideoIn(canvas);
  if (child) return { kind: "element", video: child, via: "child" };
  for (let parent = parentAcrossShadow(canvas); parent; parent = parentAcrossShadow(parent)) {
    const videos = notRendered.get(parent);
    if (!videos?.length) continue;
    if (videos.length === 1) return { kind: "element", video: videos[0]!, via: "ancestor" };
    const played = videos.filter(hasPlayed);
    if (played.length === 1) return { kind: "element", video: played[0]!, via: "ancestor" };
    if (played.length === 0) return { kind: "none" };
    const playing = played.filter(playingNow);
    if (playing.length === 1) return { kind: "element", video: playing[0]!, via: "ancestor" };
    return playing.length > 1 ? { kind: "several-playing" } : { kind: "none" };
  }
  return { kind: "none" };
}
