#!/usr/bin/env node
/**
 * Regenerates the committed demuxed-HLS e2e fixtures in
 * tests/e2e/media-fixtures/av-merge/ — the golden inputs for the
 * audio+video merge engine e2e (one video-only + one audio-only
 * fragmented-fMP4 track pair behind an EXT-X-MEDIA audio group).
 *
 * The fixtures are committed so tests never depend on ffmpeg for
 * generation; run this script only when the fixture shape must change.
 * ffprobe re-verifies each track (init + concatenated segments) before
 * the script reports success, mirroring the e2e's assertion style.
 *
 * Layout produced:
 *   master.m3u8        — hand-written: EXT-X-MEDIA TYPE=AUDIO group "aud"
 *                        + one variant referencing it via AUDIO="aud"
 *   video.m3u8         — ffmpeg VOD playlist, EXT-X-MAP video-init.mp4
 *   video-init.mp4     + video-seg000.m4s, video-seg001.m4s (H.264, no audio)
 *   audio.m3u8         — ffmpeg VOD playlist, EXT-X-MAP audio-init.mp4
 *   audio-init.mp4     + audio-seg000.m4s, audio-seg001.m4s (AAC, no video)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "tests", "e2e", "media-fixtures", "av-merge");

const ffmpeg = findExecutable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
const ffprobe = findExecutable("ffprobe", ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]);
if (!ffmpeg || !ffprobe) {
  console.error("av-merge fixtures not generated: ffmpeg/ffprobe not found. Install ffmpeg or put both on PATH.");
  process.exit(2);
}

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.42e01e,mp4a.40.2",AUDIO="aud"
video.m3u8
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Video-only fragmented fMP4: 2s of testsrc2, keyframe every 1s so ffmpeg
// splits it into two 1s media segments after the init segment.
run(ffmpeg, [
  "-v", "error",
  "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x180:rate=15",
  "-c:v", "libx264", "-profile:v", "baseline", "-preset", "veryfast", "-crf", "32",
  "-g", "15", "-keyint_min", "15", "-force_key_frames", "expr:gte(t,n_forced*1)",
  "-an",
  "-f", "hls", "-hls_segment_type", "fmp4", "-hls_time", "1", "-hls_playlist_type", "vod",
  "-hls_fmp4_init_filename", "video-init.mp4",
  "-hls_segment_filename", join(outDir, "video-seg%03d.m4s"),
  join(outDir, "video.m3u8"),
]);

// Audio-only fragmented AAC: 2s sine tone. hls_time 1 would leave a
// sub-100ms tail fragment (AAC priming pushes duration past 2s), so cut
// at 1.1s for exactly two segments.
run(ffmpeg, [
  "-v", "error",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-c:a", "aac", "-b:a", "32k",
  "-vn",
  "-f", "hls", "-hls_segment_type", "fmp4", "-hls_time", "1.1", "-hls_playlist_type", "vod",
  "-hls_fmp4_init_filename", "audio-init.mp4",
  "-hls_segment_filename", join(outDir, "audio-seg%03d.m4s"),
  join(outDir, "audio.m3u8"),
]);

writeFileSync(join(outDir, "master.m3u8"), MASTER);

// Verify each track the way the engine consumes it: init + segments
// concatenated must be one readable fragmented stream of the right codec.
verifyTrack("video", "h264");
verifyTrack("audio", "aac");

for (const name of readdirSync(outDir).sort()) {
  console.log(`${String(statSync(join(outDir, name)).size).padStart(8)}  ${name}`);
}
console.log(`✓ av-merge fixtures regenerated in ${outDir}`);

function verifyTrack(prefix, expectedCodec) {
  const segments = readdirSync(outDir).filter(n => n.startsWith(`${prefix}-seg`)).sort();
  assert(segments.length >= 1, `${prefix}: expected at least one media segment`);
  const concatenated = Buffer.concat([
    readFileSync(join(outDir, `${prefix}-init.mp4`)),
    ...segments.map(n => readFileSync(join(outDir, n))),
  ]);
  const probePath = join(outDir, `.${prefix}-concat.mp4`);
  writeFileSync(probePath, concatenated);
  try {
    const raw = execFileSync(ffprobe, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name",
      "-show_entries", "format=duration",
      "-of", "json",
      probePath,
    ], { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    const streams = parsed.streams ?? [];
    assert(streams.length === 1, `${prefix}: expected exactly one stream, got ${JSON.stringify(streams)}`);
    assert(streams[0].codec_name === expectedCodec, `${prefix}: expected ${expectedCodec}, got ${streams[0].codec_name}`);
    const duration = Number(parsed.format?.duration ?? 0);
    assert(duration > 1.5 && duration < 3, `${prefix}: unexpected duration ${duration}`);
    console.log(`✓ ${prefix} track: ${streams[0].codec_type}/${streams[0].codec_name}, ${duration.toFixed(3)}s across init + ${segments.length} segment(s)`);
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
