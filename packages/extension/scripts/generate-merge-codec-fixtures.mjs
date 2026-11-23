#!/usr/bin/env node
/**
 * Regenerates the committed VP9 and Opus inputs of the merge engine's unit
 * tests in tests/unit/engine/fixtures/: one second of video without audio and
 * one second of audio without video, each as fragmented MP4 (what a DASH
 * manifest or an HLS audio group addresses) and as WebM.
 *
 * The tests put each pair into one MP4 through the real muxer, which is the
 * evidence behind the codec families core dispatch lets into a merge.
 *
 * The fixtures are committed so tests never depend on ffmpeg; run this
 * script only when their shape must change. Needs ffmpeg with libvpx-vp9
 * and libopus.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "tests", "unit", "engine", "fixtures");

const video = ["-f", "lavfi", "-i", "testsrc2=duration=1:size=160x90:rate=5", "-c:v", "libvpx-vp9", "-b:v", "40k", "-g", "5", "-an"];
const audio = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-b:a", "16k", "-vn"];
const fragmented = ["-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"];

const outputs = [
  ["video-vp9.frag.mp4", [...video, ...fragmented]],
  ["audio-opus.frag.mp4", [...audio, "-frag_duration", "500000", ...fragmented]],
  ["video-vp9.webm", [...video, "-f", "webm"]],
  ["audio-opus.webm", [...audio, "-f", "webm"]],
];

for (const [name, args] of outputs) {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args, join(outDir, name)], { stdio: "inherit" });
  } catch (error) {
    console.error(`merge codec fixtures not generated: ffmpeg failed for ${name}. It needs libvpx-vp9 and libopus.`);
    process.exit(error?.code === "ENOENT" ? 2 : 1);
  }
  console.log(`${String(statSync(join(outDir, name)).size).padStart(8)}  ${name}`);
}
console.log(`merge codec fixtures regenerated in ${outDir}`);
