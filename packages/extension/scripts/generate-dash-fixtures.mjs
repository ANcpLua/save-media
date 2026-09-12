#!/usr/bin/env node
/**
 * Regenerates the committed clear-DASH e2e fixtures in
 * tests/e2e/media-fixtures/dash-clear/ — a real DASH packaging produced by
 * ffmpeg's dash muxer: one MPD with SegmentTemplate addressing, a video
 * AdaptationSet (H.264) and an audio AdaptationSet (AAC), plus the actual
 * init and chunk bytes.
 *
 * This is the fixture that lets the DASH claim be tested end to end rather
 * than asserted: the e2e downloads it through the av-merge engine and
 * ffprobe reads one MP4 carrying both streams.
 *
 * The fixtures are committed so tests never depend on ffmpeg for
 * generation; run this script only when the fixture shape must change.
 * Requirements the shape must keep, because the parser refuses anything
 * else (see packages/core/src/parser/dash/adapter.ts):
 *   - MPD@type="static" (a dynamic MPD expands to a live window only)
 *   - SegmentTemplate addressing, never SegmentBase/sidx byte ranges
 *   - width/height on the video Representation, codecs on both
 *   - no ContentProtection element anywhere
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "tests", "e2e", "media-fixtures", "dash-clear");
const coreFixture = resolve(here, "..", "..", "core", "tests", "fixtures", "dash", "clear-video-audio.mpd");

const ffmpeg = findExecutable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
const ffprobe = findExecutable("ffprobe", ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]);
if (!ffmpeg || !ffprobe) {
  console.error("dash fixtures not generated: ffmpeg/ffprobe not found. Install ffmpeg or put both on PATH.");
  process.exit(2);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 2 s of testsrc2 plus a 440 Hz sine, keyframe every second so the muxer
// writes two one-second chunks per stream after each init segment.
run(ffmpeg, [
  "-v", "error",
  "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x180:rate=15",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-map", "0:v:0", "-map", "1:a:0",
  "-c:v", "libx264", "-profile:v", "baseline", "-preset", "veryfast", "-crf", "32",
  "-g", "15", "-keyint_min", "15", "-force_key_frames", "expr:gte(t,n_forced*1)",
  "-c:a", "aac", "-b:a", "32k",
  "-adaptation_sets", "id=0,streams=v id=1,streams=a",
  "-use_template", "1", "-use_timeline", "0", "-seg_duration", "1",
  "-f", "dash",
  join(outDir, "clip.mpd"),
]);

const mpd = readFileSync(join(outDir, "clip.mpd"), "utf8");
assert(/type="static"/.test(mpd), "MPD must be static; a dynamic MPD is refused by design");
assert(/<SegmentTemplate\b/.test(mpd), "MPD must use SegmentTemplate addressing");
assert(!/<SegmentBase\b/.test(mpd), "SegmentBase byte-range addressing is refused by design");
assert(!/<ContentProtection\b/.test(mpd), "this fixture must stay clear: no ContentProtection");
assert(/width="320"/.test(mpd) && /height="180"/.test(mpd), "video Representation must carry width and height");
assert(/mimeType="audio\/mp4"/.test(mpd), "MPD must contain an audio AdaptationSet");

// ffmpeg can write one more chunk than the manifest addresses: AAC priming
// pushes the audio a few milliseconds past mediaPresentationDuration, and a
// player computing ceil(duration / segment duration) never asks for that
// tail. Drop what the manifest does not address, so the fixture is exactly
// the bytes a player would fetch and nothing else.
const addressed = addressedChunkCount(mpd);
for (const stream of [0, 1]) {
  const chunks = chunkFiles(stream);
  for (const extra of chunks.slice(addressed)) {
    rmSync(join(outDir, extra));
    console.log(`  dropped ${extra}: past mediaPresentationDuration, never addressed by the manifest`);
  }
}

verifyStream(0, "h264");
verifyStream(1, "aac");

// The same manifest is a core parser fixture, so parseDash and dispatch are
// tested against the exact text the e2e serves.
mkdirSync(dirname(coreFixture), { recursive: true });
writeFileSync(coreFixture, mpd);

for (const name of readdirSync(outDir).sort()) {
  console.log(`${String(statSync(join(outDir, name)).size).padStart(8)}  ${name}`);
}
console.log(`✓ clear DASH fixtures regenerated in ${outDir}`);
console.log(`✓ manifest copied to ${coreFixture}`);

/** Chunk count a player derives from the MPD: ceil(presentation / segment). */
function addressedChunkCount(manifest) {
  const presentation = iso8601Seconds(/mediaPresentationDuration="([^"]+)"/.exec(manifest)?.[1]);
  const timescale = Number(/<SegmentTemplate[^>]*timescale="(\d+)"/.exec(manifest)?.[1] ?? 1);
  const duration = Number(/<SegmentTemplate[^>]*\bduration="(\d+)"/.exec(manifest)?.[1] ?? 0);
  assert(presentation > 0 && duration > 0, "MPD must declare a presentation and segment duration");
  return Math.ceil(presentation / (duration / timescale));
}

/** Only the PT<n>S shape ffmpeg writes here; not a general ISO 8601 reader. */
function iso8601Seconds(value) {
  const match = /^PT(?:(\d+(?:\.\d+)?)M)?(\d+(?:\.\d+)?)S$/.exec(value ?? "");
  if (!match) return 0;
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

function chunkFiles(index) {
  return readdirSync(outDir).filter(n => n.startsWith(`chunk-stream${index}-`)).sort();
}

/** Verifies one stream the way the merge engine consumes it: init + chunks. */
function verifyStream(index, expectedCodec) {
  const init = `init-stream${index}.m4s`;
  const chunks = chunkFiles(index);
  assert(chunks.length >= 1, `stream ${index}: expected at least one chunk`);
  const probePath = join(outDir, `.stream${index}-concat.mp4`);
  writeFileSync(probePath, Buffer.concat([
    readFileSync(join(outDir, init)),
    ...chunks.map(n => readFileSync(join(outDir, n))),
  ]));
  try {
    const parsed = JSON.parse(execFileSync(ffprobe, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name",
      "-show_entries", "format=duration",
      "-of", "json",
      probePath,
    ], { encoding: "utf8" }));
    const streams = parsed.streams ?? [];
    assert(streams.length === 1, `stream ${index}: expected exactly one stream, got ${JSON.stringify(streams)}`);
    assert(streams[0].codec_name === expectedCodec, `stream ${index}: expected ${expectedCodec}, got ${streams[0].codec_name}`);
    const duration = Number(parsed.format?.duration ?? 0);
    assert(duration > 1.5 && duration < 3, `stream ${index}: unexpected duration ${duration}`);
    console.log(`✓ stream ${index}: ${streams[0].codec_type}/${streams[0].codec_name}, ${duration.toFixed(3)}s across ${init} + ${chunks.length} chunk(s)`);
  } finally {
    rmSync(probePath, { force: true });
  }
}

function run(bin, args) {
  execFileSync(bin, args, { stdio: "inherit" });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findExecutable(name, candidates = []) {
  for (const candidate of candidates) {
    try {
      if (candidate && statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  try {
    const found = execFileSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}
