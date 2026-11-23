import type { CollectedFrame, Rect } from "../types/page-facts";

/** How a frame's own coordinates map into the top window, and what of the frame is in view there. */
export interface FrameTransform {
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
  /** The part of the top viewport that shows this frame, or null when none of it is in view. */
  readonly clip: Rect | null;
  /** False when the frame's place in its parent could not be read: its geometry is then its own. */
  readonly measured: boolean;
}

export function intersect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function area(rect: Rect | null): number {
  return rect ? rect.width * rect.height : 0;
}

export function contains(rect: Rect | null, point: { x: number; y: number }): boolean {
  return !!rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function mapRect(transform: FrameTransform, rect: Rect): Rect {
  return { x: transform.dx + rect.x * transform.scale, y: transform.dy + rect.y * transform.scale,
    width: rect.width * transform.scale, height: rect.height * transform.scale };
}

/** A rect of the frame in top-window coordinates, cut to what is in view. */
export function toTop(transform: FrameTransform, rect: Rect | null): Rect | null {
  return rect ? intersect(mapRect(transform, rect), transform.clip) : null;
}

const pathKey = (path: readonly number[]): string => path.join("/");

export function parentOf(frame: CollectedFrame, frames: readonly CollectedFrame[]): CollectedFrame | null {
  if (!frame.path?.length) return null;
  const parentPath = pathKey(frame.path.slice(0, -1));
  return frames.find(candidate => candidate.path !== null && pathKey(candidate.path) === parentPath) ?? null;
}

function scaleOf(child: CollectedFrame, box: Rect): number {
  return child.viewport.width > 0 && box.width > 0 ? box.width / child.viewport.width : 1;
}

/** Compose every frame's place through its ancestors, from the top down. */
export function composeFrames(frames: readonly CollectedFrame[]): ReadonlyMap<number, FrameTransform> {
  const transforms = new Map<number, FrameTransform>();
  const ordered = [...frames].sort((a, b) => (a.path?.length ?? Infinity) - (b.path?.length ?? Infinity) || a.frameId - b.frameId);
  for (const frame of ordered) {
    const viewport: Rect = { x: 0, y: 0, width: frame.viewport.width, height: frame.viewport.height };
    if (frame.path?.length === 0) {
      transforms.set(frame.frameId, { scale: 1, dx: 0, dy: 0, clip: viewport, measured: true });
      continue;
    }
    const parent = parentOf(frame, frames);
    const parentTransform = parent ? transforms.get(parent.frameId) : undefined;
    const place = parent?.childFrames.find(child => child.index === frame.path!.at(-1));
    if (!parent || !parentTransform?.measured || !place) {
      transforms.set(frame.frameId, { scale: 1, dx: 0, dy: 0, clip: viewport, measured: false });
      continue;
    }
    const scale = parentTransform.scale * scaleOf(frame, place.box);
    transforms.set(frame.frameId, {
      scale,
      dx: parentTransform.dx + parentTransform.scale * place.box.x,
      dy: parentTransform.dy + parentTransform.scale * place.box.y,
      clip: toTop(parentTransform, place.visible),
      measured: true,
    });
  }
  return transforms;
}

/** A point of a child frame in its parent's coordinates. */
export function mapPointToParent(child: CollectedFrame, parent: CollectedFrame, point: { x: number; y: number }): { x: number; y: number } | null {
  const place = parent.childFrames.find(frame => frame.index === child.path?.at(-1));
  if (!place) return null;
  const scale = scaleOf(child, place.box);
  return { x: place.box.x + point.x * scale, y: place.box.y + point.y * scale };
}

/** The frame that is the child at `index` in the parent's window.frames. */
export function childOf(parent: CollectedFrame, index: number, frames: readonly CollectedFrame[]): CollectedFrame | null {
  if (parent.path === null) return null;
  const childPath = pathKey([...parent.path, index]);
  return frames.find(candidate => candidate.path !== null && candidate.path.length === parent.path!.length + 1
    && pathKey(candidate.path) === childPath) ?? null;
}

/** A point of a parent frame in the coordinates of its child, or null when the point is outside what the child shows. */
export function mapPointToChild(parent: CollectedFrame, child: CollectedFrame, point: { x: number; y: number }): { x: number; y: number } | null {
  const place = parent.childFrames.find(frame => frame.index === child.path?.at(-1));
  if (!place || !contains(place.visible ?? place.box, point)) return null;
  const scale = scaleOf(child, place.box);
  return { x: (point.x - place.box.x) / scale, y: (point.y - place.box.y) / scale };
}
