import { RETRY_POLICY } from "@savemedia/core";
import type { Logger } from "../../util/logger";

/**
 * Lazy loader for the bundled ffmpeg.wasm core. The core .js + .wasm files
 * are copied at build time into public/vendor/ffmpeg/ by the
 * scripts/copy-ffmpeg-core.mjs step. We never download them at runtime —
 * the MV3 CSP forbids remote code execution.
 *
 * The loader is invoked once per session and the result cached. Failures
 * surface as `ffmpeg_wasm_load_failed` with the retry budget exposed so
 * the runner can surface a user-facing recoverable error.
 */

export interface FFmpegLike {
  load(opts: { coreURL: string; wasmURL: string }): Promise<unknown>;
  exec(args: readonly string[]): Promise<number>;
  writeFile(filename: string, data: Uint8Array | string): Promise<unknown>;
  readFile(filename: string): Promise<Uint8Array | string>;
  terminate(): void;
  on(event: "log" | "progress", cb: (e: unknown) => void): void;
}

export interface FFmpegLoadResult {
  readonly ok: true;
  readonly instance: FFmpegLike;
}

export interface FFmpegLoadFailure {
  readonly ok: false;
  readonly bytesDownloaded: number;
  readonly totalBytes: number;
  readonly attemptsRemaining: number;
  readonly error: string;
}

export type FFmpegLoadOutcome = FFmpegLoadResult | FFmpegLoadFailure;

export interface FFmpegLoaderDeps {
  /** Returns the extension-local URL for a vendor asset. */
  readonly getURL: (path: string) => string;
  /** Optional override so tests can inject a mock @ffmpeg/ffmpeg module. */
  readonly importFFmpegModule?: () => Promise<{ FFmpeg: new () => FFmpegLike }>;
  readonly logger?: Logger;
}

let cachedInstance: FFmpegLike | null = null;
let inflight: Promise<FFmpegLoadOutcome> | null = null;

export async function loadFFmpeg(deps: FFmpegLoaderDeps): Promise<FFmpegLoadOutcome> {
  if (cachedInstance) return { ok: true, instance: cachedInstance };
  if (inflight) return inflight;

  const work = doLoad(deps);
  inflight = work;
  try {
    return await work;
  } finally {
    if (!cachedInstance) inflight = null;
  }
}

async function doLoad(deps: FFmpegLoaderDeps): Promise<FFmpegLoadOutcome> {
  const policy = RETRY_POLICY.ffmpegWasmLoad;
  let lastError = "";
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    try {
      const ffmpegMod = deps.importFFmpegModule
        ? await deps.importFFmpegModule()
        : (await import("@ffmpeg/ffmpeg")) as unknown as { FFmpeg: new () => FFmpegLike };
      const instance: FFmpegLike = new ffmpegMod.FFmpeg();
      const coreURL = deps.getURL("vendor/ffmpeg/ffmpeg-core.js");
      const wasmURL = deps.getURL("vendor/ffmpeg/ffmpeg-core.wasm");
      await instance.load({ coreURL, wasmURL });
      cachedInstance = instance;
      return { ok: true, instance };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      deps.logger?.warn("ffmpeg.wasm load failed", { attempt, err: lastError });
    }
  }
  return {
    ok: false,
    bytesDownloaded: 0,
    totalBytes: 0,
    attemptsRemaining: 0,
    error: lastError,
  };
}

export function resetFFmpegLoaderCache(): void {
  cachedInstance = null;
  inflight = null;
}
