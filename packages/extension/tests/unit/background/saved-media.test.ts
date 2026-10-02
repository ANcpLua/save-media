import { describe, it, expect, vi } from "vitest";
import { AlreadySavedError, createSavedMediaGuard, decideSave, isSameVideo, type SavedMedia, type SavedMediaDeps } from "../../../src/background/saved-media";
import type { MediaInfo } from "../../../src/engine/probe-media";

const ZEROS = "0".repeat(64);
const flipped = (bits: number) => "1".repeat(bits) + "0".repeat(64 - bits);

const portrait = (durationSec: number, height: number, frameHash: string | null = null): MediaInfo =>
  ({ durationSec, width: Math.round(height * 9 / 16), height, frameHash });
const record = (downloadId: number, m: MediaInfo): SavedMedia => ({ ...m, downloadId, filename: `${downloadId}.mp4`, replaces: [] });

describe("isSameVideo", () => {
  it("allows 0.1 s of duration difference and no more", () => {
    expect(isSameVideo(portrait(100.5, 1080), portrait(100.6, 720))).toBe(true);
    expect(isSameVideo(portrait(100.5, 1080), portrait(100.61, 720))).toBe(false);
  });

  it("never matches portrait against landscape", () => {
    expect(isSameVideo(portrait(100.5, 1080), { durationSec: 100.5, width: 1920, height: 1080, frameHash: null })).toBe(false);
  });

  it("lets the frame hash decide when both sides have one: up to 10 of 64 bits apart", () => {
    expect(isSameVideo(portrait(100.5, 1080, ZEROS), portrait(100.5, 720, flipped(10)))).toBe(true);
    expect(isSameVideo(portrait(100.5, 1080, ZEROS), portrait(100.5, 720, flipped(11)))).toBe(false);
  });

  it("needs the frame hash for whole-second durations", () => {
    expect(isSameVideo(portrait(15, 1080), portrait(15, 720))).toBe(false);
    expect(isSameVideo(portrait(15.04, 1080), portrait(15.04, 720))).toBe(false);
    expect(isSameVideo(portrait(15, 1080, ZEROS), portrait(15, 720, ZEROS))).toBe(true);
    expect(isSameVideo(portrait(15.06, 1080), portrait(15.06, 720))).toBe(true);
  });
});

describe("decideSave", () => {
  it("saves a video nothing matches", () => {
    expect(decideSave([record(1, portrait(60.5, 1080))], portrait(90.5, 1080))).toEqual({ kind: "save", replaces: [] });
  });

  it("skips a copy with equal or fewer pixels and names the best saved copy", () => {
    const low = record(1, portrait(60.5, 720));
    const high = record(2, portrait(60.5, 1080));
    expect(decideSave([low, high], portrait(60.5, 1080))).toEqual({ kind: "skip", existing: high });
    expect(decideSave([low, high], portrait(60.5, 480))).toEqual({ kind: "skip", existing: high });
  });

  it("saves a copy with more pixels and replaces only copies the frame hash confirms", () => {
    const confirmed = record(1, portrait(60.5, 720, ZEROS));
    const lengthOnly = record(2, portrait(60.5, 480));
    expect(decideSave([confirmed, lengthOnly], portrait(60.5, 1080, ZEROS))).toEqual({ kind: "save", replaces: [confirmed] });
    expect(decideSave([confirmed, lengthOnly], portrait(60.5, 1080))).toEqual({ kind: "save", replaces: [] });
  });
});

describe("createSavedMediaGuard", () => {
  function setup(probe: (url: string) => MediaInfo | null) {
    let list: readonly SavedMedia[] = [];
    let nextId = 1;
    const gone = new Set<number>();
    const deps = {
      probe: vi.fn(async (url: string) => probe(url)),
      download: vi.fn(async () => nextId++),
      read: async () => list,
      write: async (l: readonly SavedMedia[]) => { list = l; },
      exists: async (id: number) => !gone.has(id),
      remove: vi.fn(async (id: number) => { gone.add(id); }),
    } satisfies SavedMediaDeps;
    return { guard: createSavedMediaGuard(deps), deps, gone, list: () => list };
  }

  it("refuses the same video a second time without downloading it, naming the saved file", async () => {
    const { guard, deps } = setup(() => portrait(60.5, 1080));
    await guard.download({ url: "a", filename: "first.mp4" });
    const second = guard.download({ url: "b", filename: "second.mp4" });
    await expect(second).rejects.toBeInstanceOf(AlreadySavedError);
    await expect(second).rejects.toMatchObject({ existing: "first.mp4" });
    expect(deps.download).toHaveBeenCalledTimes(1);
  });

  it("refuses the second of two downloads started together", async () => {
    const { guard, deps } = setup(() => portrait(60.5, 1080));
    const results = await Promise.allSettled([
      guard.download({ url: "a", filename: "a.mp4" }),
      guard.download({ url: "b", filename: "b.mp4" }),
    ]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(deps.download).toHaveBeenCalledTimes(1);
  });

  it("downloads unchecked and records nothing when the probe cannot read the video", async () => {
    const { guard, deps, list } = setup(() => null);
    await guard.download({ url: "a", filename: "a.mp4" });
    await guard.download({ url: "a", filename: "a.mp4" });
    expect(deps.download).toHaveBeenCalledTimes(2);
    expect(list()).toEqual([]);
  });

  it("forgets a saved copy whose file is gone, so the video can be saved again", async () => {
    const { guard, gone, list } = setup(() => portrait(60.5, 1080));
    const first = await guard.download({ url: "a", filename: "a.mp4" });
    gone.add(first);
    const second = await guard.download({ url: "b", filename: "b.mp4" });
    expect(list().map(s => s.downloadId)).toEqual([second]);
  });

  it("deletes the confirmed worse copy only when the better download completes", async () => {
    let height = 720;
    const { guard, deps, list } = setup(() => portrait(60.5, height, ZEROS));
    const low = await guard.download({ url: "a", filename: "low.mp4" });
    height = 1080;
    const high = await guard.download({ url: "b", filename: "high.mp4" });
    expect(deps.remove).not.toHaveBeenCalled();

    await guard.completed(high);
    expect(deps.remove).toHaveBeenCalledWith(low);
    expect(list()).toEqual([expect.objectContaining({ downloadId: high, replaces: [] })]);
  });

  it("keeps the worse copy when the better download never completes", async () => {
    let height = 720;
    const { guard, deps, gone } = setup(() => portrait(60.5, height, ZEROS));
    await guard.download({ url: "a", filename: "low.mp4" });
    height = 1080;
    const high = await guard.download({ url: "b", filename: "high.mp4" });
    gone.add(high); // interrupted

    height = 720;
    await expect(guard.download({ url: "c", filename: "again.mp4" })).rejects.toMatchObject({ existing: "low.mp4" });
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it("ignores completions of downloads it does not track", async () => {
    const { guard, deps } = setup(() => portrait(60.5, 1080));
    await guard.completed(42);
    expect(deps.remove).not.toHaveBeenCalled();
  });
});
