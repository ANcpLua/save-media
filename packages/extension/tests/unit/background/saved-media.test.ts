import { describe, it, expect } from "vitest";
import { AlreadySavedError, createSavedMediaGuard, decideSave, isSameVideo, type SavedMedia } from "../../../src/background/saved-media";
import type { MediaInfo } from "../../../src/engine/probe-media";

const info = (durationSec: number, width: number, height: number, frameHash: string | null = null): MediaInfo =>
  ({ durationSec, width, height, frameHash });
const saved = (downloadId: number, m: MediaInfo): SavedMedia => ({ ...m, downloadId, filename: `${downloadId}.mp4`, replaces: [] });

describe("isSameVideo", () => {
  it("matches one source at different resolutions by duration", () => {
    expect(isSameVideo(info(154.4459, 1080, 1920), info(154.4459, 134, 240))).toBe(true);
  });

  it("tells videos apart by duration, orientation and frame hash", () => {
    expect(isSameVideo(info(122.67, 1080, 1920), info(124.23, 1080, 1920))).toBe(false);
    expect(isSameVideo(info(15, 1920, 1080), info(15, 1080, 1920))).toBe(false);
    expect(isSameVideo(info(15, 1080, 1920, "0".repeat(64)), info(15, 1080, 1920, "1".repeat(64)))).toBe(false);
    expect(isSameVideo(info(15, 1080, 1920, "0".repeat(64)), info(15, 720, 1280, "0".repeat(60) + "1111"))).toBe(true);
  });
});

describe("decideSave", () => {
  it("skips a copy that is not better than the saved one", () => {
    const existing = saved(1, info(220.8, 1920, 1080));
    expect(decideSave([existing], info(220.8, 1920, 1080))).toEqual({ kind: "skip", existing });
    expect(decideSave([existing], info(220.8, 426, 240))).toEqual({ kind: "skip", existing });
  });

  it("saves a better copy and marks the worse ones for removal", () => {
    const worse = saved(1, info(314.43, 1080, 1920));
    const other = saved(2, info(50.68, 1080, 1920));
    expect(decideSave([worse, other], info(314.43, 2160, 3840))).toEqual({ kind: "save", replaces: [worse] });
  });
});

describe("createSavedMediaGuard", () => {
  function setup(first: MediaInfo | null) {
    let probe = first;
    let list: readonly SavedMedia[] = [];
    let nextId = 10;
    const removed: number[] = [];
    const guard = createSavedMediaGuard({
      probe: async () => probe,
      download: async () => nextId++,
      read: async () => list,
      write: async l => { list = l; },
      exists: async id => !removed.includes(id),
      remove: async id => { removed.push(id); },
    });
    return { guard, removed, list: () => list, setProbe: (m: MediaInfo) => { probe = m; } };
  }

  it("refuses the second download of the same video", async () => {
    const { guard } = setup(info(118.07, 720, 1280));
    await guard.download({ url: "a", filename: "a.mp4" });
    await expect(guard.download({ url: "b", filename: "b.mp4" })).rejects.toBeInstanceOf(AlreadySavedError);
  });

  it("deletes the worse copy only after the better one completes", async () => {
    const { guard, removed, list, setProbe } = setup(info(154.44, 134, 240));
    const low = await guard.download({ url: "a", filename: "a.mp4" });
    setProbe(info(154.44, 1080, 1920));
    const high = await guard.download({ url: "b", filename: "b.mp4" });
    expect(removed).toEqual([]);
    await guard.completed(high);
    expect(removed).toEqual([low]);
    expect(list().map(s => s.downloadId)).toEqual([high]);
  });

  it("downloads without a record when the probe fails", async () => {
    const { guard, list } = setup(null);
    await guard.download({ url: "a", filename: "a.mp4" });
    await guard.download({ url: "a", filename: "a.mp4" });
    expect(list()).toEqual([]);
  });
});
