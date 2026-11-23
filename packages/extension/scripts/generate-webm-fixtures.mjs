#!/usr/bin/env node
/**
 * Regenerates the committed WebM e2e fixtures the main-video suite plays.
 *
 * The headless Chromium the suite runs has no H.264 decoder, so every
 * fixture a test must actually play is WebM (VP8, Opus):
 *
 *   tests/e2e/media-fixtures/low/clip.webm      a second, smaller clip (other bytes than direct/clip.webm)
 *   tests/e2e/media-fixtures/ads/creative.webm  the ad creative a VAST response names
 *   tests/e2e/media-fixtures/mse/clip.webm      video only, clustered for MediaSource appendBuffer
 *
 * The fixtures are committed so tests never depend on ffmpeg. Run this
 * script only when their shape must change: `node scripts/generate-webm-fixtures.mjs`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tests", "e2e", "media-fixtures");

function ffmpeg(output, args) {
  mkdirSync(dirname(output), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args, "-map_metadata", "-1", "-fflags", "+bitexact", output], { stdio: "inherit" });
}

const video = (source, size, seconds) => ["-f", "lavfi", "-i", `${source}=size=${size}:rate=15:duration=${seconds}`];
const tone = (hertz, seconds) => ["-f", "lavfi", "-i", `sine=frequency=${hertz}:duration=${seconds}`];
const vp8 = ["-c:v", "libvpx", "-b:v", "120k", "-g", "15"];

ffmpeg(resolve(root, "low", "clip.webm"), [...video("testsrc2", "160x90", 2), ...tone(330, 2), ...vp8, "-c:a", "libopus", "-b:a", "24k"]);
ffmpeg(resolve(root, "ads", "creative.webm"), [...video("smptebars", "160x90", 2), ...tone(880, 2), ...vp8, "-c:a", "libopus", "-b:a", "24k"]);
// One cluster per keyframe and no trailing cues: a MediaSource can append the file as it is.
ffmpeg(resolve(root, "mse", "clip.webm"), [...video("testsrc", "160x90", 2), ...vp8, "-an", "-dash", "1"]);
console.log("webm fixtures →", root);
