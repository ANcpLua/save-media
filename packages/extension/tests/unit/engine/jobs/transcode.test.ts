import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runTranscodeJob } from "../../../../src/engine/jobs/transcode";
import { resetFFmpegLoaderCache, type FFmpegLike } from "../../../../src/engine/transcode/ffmpeg-loader";
import type { TranscodePlan, RemuxPlan, VideoCodec } from "@savemedia/core";

const sourceCodec: VideoCodec = {
  rfc6381: "vp09.00.50.08",
  family: "vp9",
  profile: null,
  level: null,
};

const targetCodec: VideoCodec = {
  rfc6381: "avc1.42E01E",
  family: "h264",
  profile: "Baseline",
  level: "3.0",
};

function transcodePlan(): TranscodePlan {
  return {
    kind: "transcode",
    steps: [],
    outputContainer: "mp4",
    outputFilename: "out.mp4",
    fromVideoCodec: sourceCodec,
    toVideoCodec: targetCodec,
    engine: "ffmpeg-wasm",
  };
}

function remuxPlan(): RemuxPlan {
  return {
    kind: "remux",
    steps: [],
    fromContainer: "webm",
    outputContainer: "mp4",
    outputFilename: "out.mp4",
    estimatedBytes: null,
  };
}

class StubFFmpeg implements FFmpegLike {
  static execArgs: string[][] = [];
  static execReturn: number = 0;
  static writeFiles: Array<{ name: string; bytes: number }> = [];
  static throwOnExec = false;
  async load() { return true; }
  async exec(args: readonly string[]) {
    StubFFmpeg.execArgs.push([...args]);
    if (StubFFmpeg.throwOnExec) throw new Error("ffmpeg crashed: invalid input");
    return StubFFmpeg.execReturn;
  }
  async writeFile(name: string, data: Uint8Array | string) {
    StubFFmpeg.writeFiles.push({ name, bytes: typeof data === "string" ? data.length : data.byteLength });
    return true;
  }
  async readFile() {
    return new Uint8Array([0x66, 0x74, 0x79, 0x70]);
  }
  terminate() {}
  on() {}
}

let originalCreateObjectURL: typeof URL.createObjectURL;

beforeEach(() => {
  resetFFmpegLoaderCache();
  StubFFmpeg.execArgs = [];
  StubFFmpeg.execReturn = 0;
  StubFFmpeg.writeFiles = [];
  StubFFmpeg.throwOnExec = false;
  originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = vi.fn(() => "blob:transcoded");
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
});

describe("runTranscodeJob", () => {
  it("remux plan calls ffmpeg with -c copy", async () => {
    const r = await runTranscodeJob(
      remuxPlan(),
      { sourceBytes: new Uint8Array([1, 2, 3]), sourceFilename: "src.webm" },
      vi.fn(),
      new AbortController().signal,
      {
        getURL: p => p,
        importFFmpegModule: async () => ({ FFmpeg: StubFFmpeg }),
      },
    );
    expect(r.blobUrl).toBe("blob:transcoded");
    expect(StubFFmpeg.execArgs[0]).toEqual(["-i", "src.webm", "-c", "copy", "out.mp4"]);
  });

  it("transcode plan calls ffmpeg with libx264+aac re-encode", async () => {
    await runTranscodeJob(
      transcodePlan(),
      { sourceBytes: new Uint8Array([1, 2, 3]), sourceFilename: "src.mkv" },
      vi.fn(),
      new AbortController().signal,
      {
        getURL: p => p,
        importFFmpegModule: async () => ({ FFmpeg: StubFFmpeg }),
      },
    );
    expect(StubFFmpeg.execArgs[0]).toContain("-c:v");
    expect(StubFFmpeg.execArgs[0]).toContain("libx264");
    expect(StubFFmpeg.execArgs[0]).toContain("-c:a");
    expect(StubFFmpeg.execArgs[0]).toContain("aac");
  });

  it("sanitizes the input filename before writing into the in-memory FS", async () => {
    await runTranscodeJob(
      transcodePlan(),
      { sourceBytes: new Uint8Array([1]), sourceFilename: "weird / name $$.mkv" },
      vi.fn(),
      new AbortController().signal,
      {
        getURL: p => p,
        importFFmpegModule: async () => ({ FFmpeg: StubFFmpeg }),
      },
    );
    expect(StubFFmpeg.writeFiles[0]?.name).not.toContain("/");
    expect(StubFFmpeg.writeFiles[0]?.name).not.toContain("$");
  });

  it("translates ffmpeg crash into ffmpeg_transcode_failed for transcode plans", async () => {
    StubFFmpeg.throwOnExec = true;
    await expect(
      runTranscodeJob(
        transcodePlan(),
        { sourceBytes: new Uint8Array([1]), sourceFilename: "src.mkv" },
        vi.fn(),
        new AbortController().signal,
        {
          getURL: p => p,
          importFFmpegModule: async () => ({ FFmpeg: StubFFmpeg }),
        },
      ),
    ).rejects.toMatchObject({ code: "ffmpeg_transcode_failed" });
  });

  it("translates non-zero exit into ffmpeg_transcode_failed for transcode plans", async () => {
    StubFFmpeg.execReturn = 137;
    await expect(
      runTranscodeJob(
        transcodePlan(),
        { sourceBytes: new Uint8Array([1]), sourceFilename: "src.mkv" },
        vi.fn(),
        new AbortController().signal,
        {
          getURL: p => p,
          importFFmpegModule: async () => ({ FFmpeg: StubFFmpeg }),
        },
      ),
    ).rejects.toMatchObject({ code: "ffmpeg_transcode_failed" });
  });

  it("surfaces ffmpeg_wasm_load_failed when the loader can't load", async () => {
    await expect(
      runTranscodeJob(
        transcodePlan(),
        { sourceBytes: new Uint8Array([1]), sourceFilename: "src.mkv" },
        vi.fn(),
        new AbortController().signal,
        {
          getURL: p => p,
          importFFmpegModule: async () => { throw new Error("module not found"); },
        },
      ),
    ).rejects.toMatchObject({ code: "ffmpeg_wasm_load_failed" });
  });

  it("respects aborted signal before doing any work", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runTranscodeJob(
        transcodePlan(),
        { sourceBytes: new Uint8Array([1]), sourceFilename: "src.mkv" },
        vi.fn(),
        ac.signal,
        {
          getURL: p => p,
          importFFmpegModule: async () => ({ FFmpeg: StubFFmpeg }),
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
