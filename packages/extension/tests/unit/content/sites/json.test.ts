import { describe, expect, it } from "vitest";
import { dedupeKey, dimensionsFromUrl, isRecord, walkObjects } from "../../../../src/content/sites/json";

describe("walkObjects", () => {
  it("visits every object node in a nested tree", () => {
    const seen: string[] = [];
    walkObjects({ a: { tag: "x" }, b: [{ tag: "y" }, { tag: "z" }] }, node => {
      if (typeof node.tag === "string") seen.push(node.tag);
    });
    expect(seen.sort()).toEqual(["x", "y", "z"]);
  });

  it("stops early when the visitor returns false", () => {
    let visits = 0;
    walkObjects({ a: { deep: { deeper: { deepest: 1 } } }, b: { c: 2 } }, () => {
      visits += 1;
      return false; // stop at the very first node
    });
    expect(visits).toBe(1);
  });

  it("terminates on cyclic references", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", a };
    a.b = b; // cycle
    const names: unknown[] = [];
    expect(() => walkObjects(a, node => { names.push(node.name); })).not.toThrow();
    expect(names.sort()).toEqual(["a", "b"]);
  });
});

describe("dedupeKey", () => {
  it("drops the query token so CDN variants of one asset collapse", () => {
    expect(dedupeKey("https://cdn/x.mp4?tag=12")).toBe("https://cdn/x.mp4");
    expect(dedupeKey("https://cdn/x.mp4")).toBe("https://cdn/x.mp4");
  });
});

describe("dimensionsFromUrl", () => {
  it("reads WxH from a CDN path segment", () => {
    expect(dimensionsFromUrl("https://cdn/vid/1280x720/high.mp4")).toEqual({ width: 1280, height: 720 });
    expect(dimensionsFromUrl("https://cdn/vid/high.mp4")).toEqual({ width: null, height: null });
  });
});

describe("isRecord", () => {
  it("accepts plain objects and rejects arrays/null/primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("s")).toBe(false);
  });
});
