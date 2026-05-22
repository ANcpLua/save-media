import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadFFmpeg, resetFFmpegLoaderCache, type FFmpegLike } from "../../../../src/engine/transcode/ffmpeg-loader";

class FakeFFmpeg implements FFmpegLike {
  static loadShould: "ok" | "throw-once" | "throw" = "ok";
  static loadAttempts = 0;
  async load(_opts: { coreURL: string; wasmURL: string }) {
    FakeFFmpeg.loadAttempts += 1;
    if (FakeFFmpeg.loadShould === "throw") throw new Error("load failed");
    if (FakeFFmpeg.loadShould === "throw-once" && FakeFFmpeg.loadAttempts < 2) {
      throw new Error("network glitch");
    }
    return true;
  }
  async exec() { return 0; }
  async writeFile() { return true; }
  async readFile() { return new Uint8Array([0]); }
  terminate() {}
  on() {}
}

beforeEach(() => {
  resetFFmpegLoaderCache();
  FakeFFmpeg.loadShould = "ok";
  FakeFFmpeg.loadAttempts = 0;
});

describe("loadFFmpeg", () => {
  it("loads on first attempt and caches the instance", async () => {
    const importMock = vi.fn(async () => ({ FFmpeg: FakeFFmpeg }));
    const r1 = await loadFFmpeg({ getURL: p => `ext://${p}`, importFFmpegModule: importMock });
    expect(r1.ok).toBe(true);
    const r2 = await loadFFmpeg({ getURL: p => `ext://${p}`, importFFmpegModule: importMock });
    expect(r2.ok).toBe(true);
    // Cached → import is called once, instance is the same object
    expect(importMock).toHaveBeenCalledTimes(1);
    if (r1.ok && r2.ok) expect(r1.instance).toBe(r2.instance);
  });

  it("passes coreURL + wasmURL pointing at the extension's vendor folder", async () => {
    const seen: Array<{ coreURL: string; wasmURL: string }> = [];
    class Spy extends FakeFFmpeg {
      override async load(opts: { coreURL: string; wasmURL: string }) {
        seen.push(opts);
        return true;
      }
    }
    await loadFFmpeg({
      getURL: p => `chrome-extension://abc/${p}`,
      importFFmpegModule: async () => ({ FFmpeg: Spy as unknown as new () => FFmpegLike }),
    });
    expect(seen[0]?.coreURL).toBe("chrome-extension://abc/vendor/ffmpeg/ffmpeg-core.js");
    expect(seen[0]?.wasmURL).toBe("chrome-extension://abc/vendor/ffmpeg/ffmpeg-core.wasm");
  });

  it("retries up to RETRY_POLICY.ffmpegWasmLoad.maxAttempts and reports failure", async () => {
    FakeFFmpeg.loadShould = "throw";
    const r = await loadFFmpeg({
      getURL: p => p,
      importFFmpegModule: async () => ({ FFmpeg: FakeFFmpeg }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("load failed");
      expect(r.attemptsRemaining).toBe(0);
    }
    expect(FakeFFmpeg.loadAttempts).toBe(3); // ffmpegWasmLoad maxAttempts
  });

  it("recovers after a transient failure", async () => {
    FakeFFmpeg.loadShould = "throw-once";
    const r = await loadFFmpeg({
      getURL: p => p,
      importFFmpegModule: async () => ({ FFmpeg: FakeFFmpeg }),
    });
    expect(r.ok).toBe(true);
    expect(FakeFFmpeg.loadAttempts).toBe(2);
  });

  it("dedupes concurrent load calls", async () => {
    let count = 0;
    const importMock = vi.fn(async () => {
      count += 1;
      return { FFmpeg: FakeFFmpeg };
    });
    const [a, b] = await Promise.all([
      loadFFmpeg({ getURL: p => p, importFFmpegModule: importMock }),
      loadFFmpeg({ getURL: p => p, importFFmpegModule: importMock }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(count).toBe(1);
  });
});
