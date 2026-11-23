import { describe, expect, it } from "vitest";
import { area, composeFrames, mapPointToParent, toTop } from "../../../src/selection/frame-geometry";
import { frame } from "./helpers";

describe("frame geometry", () => {
  const top = frame(0, { viewport: { width: 1000, height: 800 },
    childFrames: [{ index: 0, box: { x: 100, y: 200, width: 400, height: 300 }, visible: { x: 100, y: 200, width: 400, height: 300 } }] });

  it("maps a nested frame through its ancestors, with scale", () => {
    const child = frame(3, { path: [0], viewport: { width: 800, height: 600 },
      childFrames: [{ index: 0, box: { x: 80, y: 40, width: 200, height: 100 }, visible: { x: 80, y: 40, width: 200, height: 100 } }] });
    const grandchild = frame(7, { path: [0, 0], viewport: { width: 200, height: 100 } });
    const transforms = composeFrames([grandchild, top, child]);
    expect(transforms.get(0)).toEqual({ scale: 1, dx: 0, dy: 0, clip: { x: 0, y: 0, width: 1000, height: 800 }, measured: true });
    expect(transforms.get(3)).toMatchObject({ scale: 0.5, dx: 100, dy: 200, measured: true });
    expect(transforms.get(7)).toMatchObject({ scale: 0.5, dx: 140, dy: 220, measured: true });
    expect(toTop(transforms.get(7)!, { x: 0, y: 0, width: 200, height: 100 })).toEqual({ x: 140, y: 220, width: 100, height: 50 });
  });

  it("gives everything in a frame that is out of view an area of zero", () => {
    const hidden = frame(0, { childFrames: [{ index: 0, box: { x: 0, y: 3000, width: 640, height: 360 }, visible: null }] });
    const child = frame(3, { viewport: { width: 640, height: 360 } });
    const transform = composeFrames([hidden, child]).get(3)!;
    expect(transform.clip).toBeNull();
    expect(area(toTop(transform, { x: 0, y: 0, width: 640, height: 360 }))).toBe(0);
  });

  it("cuts a frame's content to the part of the frame that is in view", () => {
    const partly = frame(0, { viewport: { width: 1000, height: 800 },
      childFrames: [{ index: 0, box: { x: 800, y: 0, width: 400, height: 300 }, visible: { x: 800, y: 0, width: 200, height: 300 } }] });
    const transform = composeFrames([partly, frame(3, { viewport: { width: 400, height: 300 } })]).get(3)!;
    expect(toTop(transform, { x: 0, y: 0, width: 400, height: 300 })).toEqual({ x: 800, y: 0, width: 200, height: 300 });
  });

  it("keeps a frame whose place cannot be read in its own coordinates, marked unmeasured", () => {
    const lost = frame(5, { path: null, viewport: { width: 300, height: 200 } });
    const orphan = frame(6, { path: [4], viewport: { width: 300, height: 200 } });
    const transforms = composeFrames([top, lost, orphan]);
    expect(transforms.get(5)).toEqual({ scale: 1, dx: 0, dy: 0, clip: { x: 0, y: 0, width: 300, height: 200 }, measured: false });
    expect(transforms.get(6)?.measured).toBe(false);
  });

  it("maps a point of a child frame into its parent, past the frame's border and padding", () => {
    const child = frame(3, { path: [0], viewport: { width: 800, height: 600 } });
    expect(mapPointToParent(child, top, { x: 400, y: 300 })).toEqual({ x: 300, y: 350 });
    expect(mapPointToParent(frame(4, { path: [9] }), top, { x: 1, y: 1 })).toBeNull();
  });
});
