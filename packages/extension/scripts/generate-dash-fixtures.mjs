#!/usr/bin/env bun
/**
 * Regenerates the committed clear-DASH e2e fixtures: real DASH packagings
 * produced by ffmpeg's dash muxer, each with its manifest and the actual
 * media bytes.
 *
 *   tests/e2e/media-fixtures/dash-clear/        a video AdaptationSet (H.264)
 *                                               and an audio AdaptationSet
 *                                               (AAC), SegmentTemplate
 *   tests/e2e/media-fixtures/dash-video-only/   the video AdaptationSet alone,
 *                                               as a muted clip is published
 *   tests/e2e/media-fixtures/dash-single-file/  each representation kept in
 *                                               one file, with two manifests
 *                                               for the same two files:
 *                                               clip.mpd lists byte ranges
 *                                               (SegmentList), on-demand.mpd
 *                                               names the index range
 *                                               (SegmentBase)
 *   tests/e2e/media-fixtures/direct/clip-dash-brand.mp4
 *                                               one fragmented MP4 file under
 *                                               the major brand "dash", video
 *                                               and audio together, as a page
 *                                               plays it directly
 *
 * These are the fixtures that let the DASH claims be tested end to end
 * rather than asserted: the e2e downloads each through the engine and
 * compares the decoded frames of the saved MP4 with the decoded frames of
 * the fixture's own bytes.
 *
 * The fixtures are committed so tests never depend on ffmpeg for
 * generation; run this script only when a fixture's shape must change.
 * Without arguments it regenerates all of them. `video-audio`, `video-only`,
 * `single-file` or `brand-file` as arguments regenerate those alone: ffmpeg
 * versions differ in the bytes they write, so a regenerated fixture is a
 * new fixture.
 * Requirements every manifest must keep, because the parser materializes
 * nothing else (see packages/core/src/parser/dash/adapter.ts):
 *   - MPD@type="static" (a dynamic MPD expands to a live window only)
 *   - segments under their own addresses (SegmentTemplate), or one file per
 *     representation whose byte ranges cover it from its start without a gap
 *   - width/height on the video Representation, codecs on every one
 *   - no ContentProtection element anywhere
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "tests", "e2e", "media-fixtures");
const coreFixtures = resolve(here, "..", "..", "core", "tests", "fixtures", "dash");

const ffmpeg = findExecutable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
const ffprobe = findExecutable("ffprobe", ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]);
if (!ffmpeg || !ffprobe) {
  console.error("dash fixtures not generated: ffmpeg/ffprobe not found. Install ffmpeg or put both on PATH.");
  process.exit(2);
}

const KINDS = {
  "video-audio": () => generate({ dir: "dash-clear", coreFixture: "clear-video-audio.mpd", audio: true }),
  "video-only": () => generate({ dir: "dash-video-only", coreFixture: "clear-video-only.mpd", audio: false }),
  "single-file": generateSingleFile,
  "brand-file": generateBrandFile,
};
const asked = process.argv.slice(2);
for (const name of asked) {
  if (!(name in KINDS)) {
    console.error(`unknown fixture "${name}". Choose from: ${Object.keys(KINDS).join(", ")}.`);
    process.exit(2);
  }
}

let outDir = "";
for (const name of asked.length ? asked : Object.keys(KINDS)) KINDS[name]();

/** The picture and sound every fixture here is made of: 2 s of testsrc2 at 15 frames a second, and a 440 Hz sine. */
function sourceArgs(audio) {
  return [
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x180:rate=15",
    ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"] : []),
    "-map", "0:v:0", ...(audio ? ["-map", "1:a:0"] : ["-an"]),
    "-c:v", "libx264", "-profile:v", "baseline", "-preset", "veryfast", "-crf", "32",
    "-g", "15", "-keyint_min", "15", "-force_key_frames", "expr:gte(t,n_forced*1)",
    ...(audio ? ["-c:a", "aac", "-b:a", "32k"] : []),
  ];
}

/** The top-level boxes of an MP4 file: type, offset and size. */
function boxes(bytes) {
  const found = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    assert(size >= 8, `box of ${size} bytes at ${offset}: not a fixture this script reads`);
    found.push({ type: bytes.toString("latin1", offset + 4, offset + 8), offset, size });
    offset += size;
  }
  return found;
}

function probe(file) {
  return JSON.parse(execFileSync(ffprobe, [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-show_entries", "format=duration", "-of", "json", file,
  ], { encoding: "utf8" }));
}

/**
 * Each representation in one file: a header (ftyp, moov), an index (sidx)
 * and the movie fragments. ffmpeg writes the manifest as a list of byte
 * ranges (clip.mpd). The on-demand profile describes the same files by the
 * place of their index instead (on-demand.mpd), which is written here from
 * the files' own boxes.
 */
function generateSingleFile() {
  outDir = join(fixtures, "dash-single-file");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  run(ffmpeg, [
    ...sourceArgs(true),
    "-adaptation_sets", "id=0,streams=v id=1,streams=a",
    "-single_file", "1", "-global_sidx", "1", "-seg_duration", "1",
    "-f", "dash",
    join(outDir, "clip.mpd"),
  ]);

  const mpd = readFileSync(join(outDir, "clip.mpd"), "utf8");
  assert(/type="static"/.test(mpd), "MPD must be static");
  assert(!/<ContentProtection\b/.test(mpd), "this fixture must stay clear: no ContentProtection");
  assert(/width="320"/.test(mpd) && /height="180"/.test(mpd), "video Representation must carry width and height");
  const lists = [...mpd.matchAll(/<SegmentList\b[\s\S]*?<\/SegmentList>/g)];
  assert(lists.length === 2, `expected one SegmentList per representation, got ${lists.length}`);

  let onDemand = mpd.replace("urn:mpeg:dash:profile:isoff-live:2011", "urn:mpeg:dash:profile:isoff-on-demand:2011");
  for (const [index, codec] of [[0, "h264"], [1, "aac"]]) {
    const name = `clip-stream${index}.mp4`;
    const bytes = readFileSync(join(outDir, name));
    const layout = boxes(bytes);
    assert(layout.map(box => box.type).slice(0, 3).join(" ") === "ftyp moov sidx", `${name}: expected ftyp, moov, sidx first, got ${layout.map(box => box.type).join(" ")}`);
    const sidx = layout[2];
    // The manifest's ranges must cover the file from its first byte to its last without a gap.
    const ranges = [...lists[index][0].matchAll(/(?:range|mediaRange)="(\d+)-(\d+)"/g)].map(match => [Number(match[1]), Number(match[2])]);
    let next = 0;
    for (const [start, end] of ranges) {
      assert(start === next, `${name}: range ${start}-${end} does not follow byte ${next - 1}`);
      next = end + 1;
    }
    assert(next === bytes.length, `${name}: the ranges end at byte ${next - 1}, the file at ${bytes.length - 1}`);
    assert(ranges[0][1] === sidx.offset + sidx.size - 1, `${name}: the first range must hold the header and the index`);
    onDemand = onDemand.replace(lists[index][0],
      `<SegmentBase indexRange="${sidx.offset}-${sidx.offset + sidx.size - 1}">\n\t\t\t\t\t<Initialization range="0-${sidx.offset - 1}" />\n\t\t\t\t</SegmentBase>`);
    const parsed = probe(join(outDir, name));
    assert(parsed.streams?.length === 1 && parsed.streams[0].codec_name === codec, `${name}: expected one ${codec} stream, got ${JSON.stringify(parsed.streams)}`);
    console.log(`✓ ${name}: ${codec}, ${bytes.length} bytes, index at ${sidx.offset}-${sidx.offset + sidx.size - 1}`);
  }
  assert(!/<SegmentList\b/.test(onDemand) && (onDemand.match(/<SegmentBase\b/g) ?? []).length === 2, "on-demand.mpd must describe both files by SegmentBase");
  writeFileSync(join(outDir, "on-demand.mpd"), onDemand);

  mkdirSync(coreFixtures, { recursive: true });
  writeFileSync(join(coreFixtures, "clear-single-file-ranges.mpd"), mpd);
  writeFileSync(join(coreFixtures, "clear-single-file-indexed.mpd"), onDemand);
  for (const name of readdirSync(outDir).sort()) console.log(`${String(statSync(join(outDir, name)).size).padStart(8)}  ${name}`);
  console.log(`✓ single-file DASH fixture regenerated in ${outDir}; both manifests copied to ${coreFixtures}`);
}

/**
 * One fragmented MP4 file with video and audio under the major brand "dash":
 * what a page hands a video element when it plays such a file directly.
 */
function generateBrandFile() {
  const file = join(fixtures, "direct", "clip-dash-brand.mp4");
  run(ffmpeg, [
    ...sourceArgs(true),
    "-movflags", "+dash+frag_keyframe+empty_moov+default_base_moof", "-brand", "dash",
    "-f", "mp4", "-y", file,
  ]);
  const bytes = readFileSync(file);
  const layout = boxes(bytes).map(box => box.type);
  assert(bytes.toString("latin1", 8, 12) === "dash", `expected the major brand "dash", got "${bytes.toString("latin1", 8, 12)}"`);
  assert(layout[0] === "ftyp" && layout[1] === "moov" && layout.includes("moof") && layout.includes("mdat"), `expected a fragmented file, got ${layout.join(" ")}`);
  const codecs = (probe(file).streams ?? []).map(stream => stream.codec_name).sort().join(" ");
  assert(codecs === "aac h264", `expected h264 and aac, got ${codecs}`);
  console.log(`✓ ${file}: ${bytes.length} bytes, ${layout.join(" ")}`);
}

function generate({ dir, coreFixture, audio }) {
  outDir = join(fixtures, dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 2 s of testsrc2 (and a 440 Hz sine), keyframe every second so the muxer
  // writes two one-second chunks per stream after each init segment.
  run(ffmpeg, [
    ...sourceArgs(audio),
    "-adaptation_sets", audio ? "id=0,streams=v id=1,streams=a" : "id=0,streams=v",
    "-use_template", "1", "-use_timeline", "0", "-seg_duration", "1",
    "-f", "dash",
    join(outDir, "clip.mpd"),
  ]);

  const mpd = readFileSync(join(outDir, "clip.mpd"), "utf8");
  assert(/type="static"/.test(mpd), "MPD must be static; a dynamic MPD lists only the current window");
  assert(/<SegmentTemplate\b/.test(mpd), "MPD must use SegmentTemplate addressing");
  assert(!/<SegmentBase\b/.test(mpd), "SegmentBase byte-range addressing is not what this fixture covers");
  assert(!/<ContentProtection\b/.test(mpd), "this fixture must stay clear: no ContentProtection");
  assert(/width="320"/.test(mpd) && /height="180"/.test(mpd), "video Representation must carry width and height");
  assert(/mimeType="audio\/mp4"/.test(mpd) === audio, audio ? "MPD must contain an audio AdaptationSet" : "MPD must declare no audio at all");

  // ffmpeg can write one more chunk than the manifest addresses: AAC priming
  // pushes the audio a few milliseconds past mediaPresentationDuration, and a
  // player computing ceil(duration / segment duration) never asks for that
  // tail. Drop what the manifest does not address, so the fixture is exactly
  // the bytes a player would fetch and nothing else.
  const addressed = addressedChunkCount(mpd);
  const streams = audio ? [0, 1] : [0];
  for (const stream of streams) {
    const chunks = chunkFiles(stream);
    for (const extra of chunks.slice(addressed)) {
      rmSync(join(outDir, extra));
      console.log(`  dropped ${extra}: past mediaPresentationDuration, never addressed by the manifest`);
    }
  }

  verifyStream(0, "h264");
  if (audio) verifyStream(1, "aac");

  // The same manifest is a core parser fixture, so parseDash and dispatch are
  // tested against the exact text the e2e serves.
  mkdirSync(coreFixtures, { recursive: true });
  writeFileSync(join(coreFixtures, coreFixture), mpd);

  for (const name of readdirSync(outDir).sort()) {
    console.log(`${String(statSync(join(outDir, name)).size).padStart(8)}  ${name}`);
  }
  console.log(`✓ clear DASH fixture regenerated in ${outDir}`);
  console.log(`✓ manifest copied to ${join(coreFixtures, coreFixture)}`);
}

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
    const parsed = probe(probePath);
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
