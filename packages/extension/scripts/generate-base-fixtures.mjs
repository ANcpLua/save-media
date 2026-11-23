#!/usr/bin/env bun
/**
 * Says how the oldest committed media fixtures are made, and makes them
 * again. They came into the repository before the other generators and had
 * no recipe; every other fixture is covered by the generate-*-fixtures
 * script that names it.
 *
 * End-to-end fixtures (tests/e2e/media-fixtures/):
 *   direct/clip.mp4          two seconds of ffmpeg's testsrc2 at 320x180, 15
 *                            frames a second, H.264 Constrained Baseline with
 *                            an 880 Hz tone as AAC: the progressive file most
 *                            suites save
 *   low/clip.mp4             the same picture with a 440 Hz tone: a second
 *                            file with other bytes
 *   direct/clip.webm         the same picture as VP8 with a 660 Hz tone as
 *                            Opus
 *   direct/clip.mkv          direct/clip.mp4's packets in a Matroska file
 *   direct/test-pattern.mov  one second of testsrc2 at 160x90 as a QuickTime
 *                            movie, no sound
 *   direct/color-bars.mov    one second of colour bars with a tone as a
 *                            QuickTime movie that has no file-type box, as
 *                            older QuickTime writers leave it: the leading
 *                            ftyp box is renamed to free
 *   hls/                     direct/clip.mp4's packets as one MPEG-TS segment
 *                            behind a master and a media playlist
 *   hls-aes/                 that segment under AES-128 with the key file
 *                            next to the playlist and the IV stated in it
 *   hls-fmp4/                direct/clip.mp4's packets as an init section and
 *                            one fMP4 segment
 *
 * Unit test fixtures:
 *   tests/unit/engine/fixtures/video-only.mp4   one second of H.264, no sound
 *   tests/unit/engine/fixtures/audio-only.m4a   one second of AAC, no picture
 *   ../core/tests/fixtures/init-segments/h264-baseline.mp4
 *                            a fragmented MP4 with one H.264 Constrained
 *                            Baseline frame at 320x240, read by core's
 *                            init-segment tests
 *
 * The fixtures are committed, so tests never depend on ffmpeg for
 * generation. Without arguments this script builds everything in a
 * temporary directory, checks what it built, and reports how each file
 * compares with the committed one: the same streams, or what differs. With
 * --write it replaces the committed files. ffmpeg versions differ in the
 * bytes they write, so a replaced fixture is a new fixture: tests that
 * compare bytes read the file on disk, and the recovery tests cut
 * direct/clip.mp4 at a fixed byte, which the checks below keep inside it.
 *
 * Needs ffmpeg and ffprobe with libx264, libvpx and libopus.
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Fixture paths below are relative to the packages folder, because one fixture belongs to core. */
const packages = resolve(here, "..", "..");
const E2E = "extension/tests/e2e/media-fixtures";
const UNIT = "extension/tests/unit/engine/fixtures";
const CORE = "core/tests/fixtures/init-segments";
const write = process.argv.includes("--write");

/** The recovery tests interrupt direct/clip.mp4 after this many bytes. */
const RECOVERY_CUT_BYTES = 58013;
/** A stated rate gives the two-second clips a length the cut lies well inside. */
const CLIP_VIDEO_RATE = "400k";

const work = mkdtempSync(join(tmpdir(), "savemedia-base-fixtures-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const built = [];

function out(path) {
  const file = join(work, path);
  mkdirSync(dirname(file), { recursive: true });
  built.push(path);
  return file;
}

function ffmpeg(args) {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
  } catch (error) {
    console.error("base fixtures not generated: ffmpeg failed or is not installed. It needs libx264, libvpx and libopus.");
    process.exit(error?.code === "ENOENT" ? 2 : 1);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** What a decoder is told about a file: its streams and its length. */
function facts(file) {
  const parsed = JSON.parse(execFileSync("ffprobe", ["-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,profile,width,height,sample_rate,channels",
    "-of", "json", file], { encoding: "utf8" }));
  return {
    seconds: Number(parsed.format?.duration ?? 0),
    streams: (parsed.streams ?? []).map(stream => [stream.codec_type, stream.codec_name, stream.profile, stream.width && `${stream.width}x${stream.height}`,
      stream.sample_rate && `${stream.sample_rate} Hz`, stream.channels && `${stream.channels} ch`].filter(Boolean).join(" ")),
  };
}

/** The encoded packets of one stream, as one hash: the same packets in another container give the same hash. */
function packets(file, stream, format, extra = []) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", stream, "-c", "copy", ...extra, "-f", format, "-"], { maxBuffer: 64 * 1024 * 1024 })
    .toString("base64");
}

/** The top-level boxes of an MP4 or QuickTime file, in order. */
function boxes(file) {
  const bytes = readFileSync(file);
  const names = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    names.push(bytes.toString("latin1", offset + 4, offset + 8));
    if (size < 8) break;
    offset += size;
  }
  return names;
}

const picture = (source, size, rate, seconds) => ["-f", "lavfi", "-i", `${source}=duration=${seconds}:size=${size}:rate=${rate}`];
const tone = (hertz, seconds) => ["-f", "lavfi", "-i", `sine=frequency=${hertz}:duration=${seconds}`];
const both = ["-map", "0:v:0", "-map", "1:a:0"];
const h264 = profile => ["-c:v", "libx264", ...(profile ? ["-profile:v", profile] : []), "-preset", "veryfast", "-pix_fmt", "yuv420p"];
const aac = ["-c:a", "aac", "-b:a", "64k", "-ac", "1"];
const MASTER = version => `#EXTM3U
#EXT-X-VERSION:${version}
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.42e01e,mp4a.40.2"
media.m3u8
`;

// ---- progressive files ----
const clip = out(`${E2E}/direct/clip.mp4`);
ffmpeg([...picture("testsrc2", "320x180", 15, 2), ...tone(880, 2), ...both, ...h264("baseline"), "-b:v", CLIP_VIDEO_RATE, "-g", "15", ...aac, clip]);
assert(statSync(clip).size > RECOVERY_CUT_BYTES * 3 / 2, `direct/clip.mp4 must run well past byte ${RECOVERY_CUT_BYTES}, where the recovery tests cut it`);

const low = out(`${E2E}/low/clip.mp4`);
ffmpeg([...picture("testsrc2", "320x180", 15, 2), ...tone(440, 2), ...both, ...h264("baseline"), "-b:v", CLIP_VIDEO_RATE, "-g", "15", ...aac, low]);
assert(!readFileSync(low).equals(readFileSync(clip)), "low/clip.mp4 must differ from direct/clip.mp4");

const webm = out(`${E2E}/direct/clip.webm`);
ffmpeg([...picture("testsrc2", "320x180", 15, 2), ...tone(660, 2), ...both, "-c:v", "libvpx", "-b:v", "300k", "-g", "15", "-c:a", "libopus", "-b:a", "32k", "-ac", "1", webm]);

const mkv = out(`${E2E}/direct/clip.mkv`);
ffmpeg(["-i", clip, "-c", "copy", mkv]);
assert(packets(mkv, "0:a:0", "adts") === packets(clip, "0:a:0", "adts"), "direct/clip.mkv must hold direct/clip.mp4's audio packets");
assert(packets(mkv, "0:v:0", "h264", ["-bsf:v", "h264_mp4toannexb"]) === packets(clip, "0:v:0", "h264", ["-bsf:v", "h264_mp4toannexb"]),
  "direct/clip.mkv must hold direct/clip.mp4's video packets");

// ---- QuickTime movies ----
const pattern = out(`${E2E}/direct/test-pattern.mov`);
ffmpeg([...picture("testsrc2", "160x90", 12, 1), ...h264(null), "-an", "-f", "mov", pattern]);
assert(boxes(pattern)[0] === "ftyp", "direct/test-pattern.mov must start with its file-type box");

const bars = out(`${E2E}/direct/color-bars.mov`);
ffmpeg([...picture("smptebars", "160x90", 12, 1), ...tone(880, 1), ...both, ...h264(null), ...aac, "-f", "mov", bars]);
{
  // The file-type box becomes free space of the same size: every other byte, and every offset in the file, stays.
  const bytes = readFileSync(bars);
  assert(bytes.toString("latin1", 4, 8) === "ftyp", "ffmpeg must write the file-type box first");
  bytes.write("free", 4, "latin1");
  writeFileSync(bars, bytes);
  assert(!boxes(bars).includes("ftyp") && boxes(bars).includes("moov") && boxes(bars).includes("mdat"), "direct/color-bars.mov must be a movie without a file-type box");
  assert(facts(bars).streams.length === 2, "direct/color-bars.mov must still read as a video and an audio stream");
}

// ---- HLS: one MPEG-TS segment, the same under AES-128, and one fMP4 segment ----
const hlsDir = dirname(out(`${E2E}/hls/media.m3u8`));
ffmpeg(["-i", clip, "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
  "-hls_segment_filename", join(hlsDir, "seg%03d.ts"), join(hlsDir, "media.m3u8")]);
writeFileSync(out(`${E2E}/hls/master.m3u8`), MASTER(6));
built.push(`${E2E}/hls/seg000.ts`);
const playlist = readFileSync(join(hlsDir, "media.m3u8"), "utf8");
assert(readdirSync(hlsDir).filter(name => name.endsWith(".ts")).join(" ") === "seg000.ts", `hls/ must hold one segment, got ${readdirSync(hlsDir).join(", ")}`);
assert(playlist.includes("#EXT-X-MEDIA-SEQUENCE:0") && playlist.includes("#EXT-X-ENDLIST"), "hls/media.m3u8 must be a finished VOD that starts at sequence 0");
assert(packets(join(hlsDir, "seg000.ts"), "0:a:0", "adts") === packets(clip, "0:a:0", "adts"), "hls/seg000.ts must hold direct/clip.mp4's audio packets");

// A fixed key keeps the fixture reproducible. It protects nothing: it is served next to the playlist.
const key = Buffer.alloc(16, 0xa5);
const iv = Buffer.alloc(16);
const plain = readFileSync(join(hlsDir, "seg000.ts"));
const cipher = createCipheriv("aes-128-cbc", key, iv);
const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
const decipher = createDecipheriv("aes-128-cbc", key, iv);
assert(Buffer.concat([decipher.update(encrypted), decipher.final()]).equals(plain), "hls-aes/seg000.ts must decrypt to hls/seg000.ts");
writeFileSync(out(`${E2E}/hls-aes/seg000.ts`), encrypted);
writeFileSync(out(`${E2E}/hls-aes/key.bin`), key);
writeFileSync(out(`${E2E}/hls-aes/master.m3u8`), MASTER(6));
const keyed = playlist.replace(/(#EXT-X-PLAYLIST-TYPE:VOD\n)/, `$1#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString("hex")}\n`);
assert(keyed.includes("#EXT-X-KEY:") && keyed.includes("IV=0x"), "hls-aes/media.m3u8 must name the key and its IV");
writeFileSync(out(`${E2E}/hls-aes/media.m3u8`), keyed);

const fmp4Dir = dirname(out(`${E2E}/hls-fmp4/media.m3u8`));
ffmpeg(["-i", clip, "-c", "copy", "-f", "hls", "-hls_segment_type", "fmp4", "-hls_time", "2", "-hls_playlist_type", "vod",
  "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(fmp4Dir, "seg%03d.m4s"), join(fmp4Dir, "media.m3u8")]);
writeFileSync(out(`${E2E}/hls-fmp4/master.m3u8`), MASTER(7));
built.push(`${E2E}/hls-fmp4/init.mp4`, `${E2E}/hls-fmp4/seg000.m4s`);
assert(readdirSync(fmp4Dir).filter(name => name.endsWith(".m4s")).join(" ") === "seg000.m4s", `hls-fmp4/ must hold one segment, got ${readdirSync(fmp4Dir).join(", ")}`);
assert(readFileSync(join(fmp4Dir, "media.m3u8"), "utf8").includes('#EXT-X-MAP:URI="init.mp4"'), "hls-fmp4/media.m3u8 must name its init section");
assert(boxes(join(fmp4Dir, "init.mp4")).join(" ") === "ftyp moov", "hls-fmp4/init.mp4 must be a file-type box and a movie box");

// ---- unit test inputs ----
const videoOnly = out(`${UNIT}/video-only.mp4`);
ffmpeg([...picture("testsrc", "320x240", 15, 1), ...h264(null), "-an", videoOnly]);
const audioOnly = out(`${UNIT}/audio-only.m4a`);
ffmpeg([...tone(440, 1), ...aac, "-vn", audioOnly]);
assert(facts(videoOnly).streams.length === 1 && facts(audioOnly).streams.length === 1, "the unit test inputs must each hold one stream");

const init = out(`${CORE}/h264-baseline.mp4`);
ffmpeg(["-f", "lavfi", "-i", "color=c=red:size=320x240:rate=25", "-frames:v", "1", ...h264("baseline"), "-level", "3.0", "-an",
  "-movflags", "+frag_keyframe+empty_moov+default_base_moof", init]);
assert(["ftyp", "moov", "moof", "mdat"].every(name => boxes(init).includes(name)), `h264-baseline.mp4 must be a fragmented MP4, got ${boxes(init).join(" ")}`);

// ---- report, and replace the committed files when asked ----
const MEDIA = /\.(?:mp4|m4a|m4s|mov|mkv|webm|ts)$/;
const describe = file => {
  const { seconds, streams } = facts(file);
  return `${streams.join(" + ")}, ${seconds.toFixed(1)} s`;
};
let differing = 0;
for (const path of [...new Set(built)].sort()) {
  const made = join(work, path);
  const committed = join(packages, path);
  let verdict;
  if (!existsSync(committed)) verdict = "no committed file";
  else if (readFileSync(committed).equals(readFileSync(made))) verdict = "identical to the committed file";
  // A segment alone, or ciphertext, is no file a decoder reads: its folder's other files carry the comparison.
  else if (!MEDIA.test(path) || /hls-aes\/seg|\.m4s$/.test(path)) verdict = "other bytes than the committed file";
  else if (describe(made) === describe(committed)) verdict = "the committed file's streams, other bytes";
  else { verdict = `DIFFERS: made ${describe(made)}; committed ${describe(committed)}`; differing++; }
  console.log(`${String(statSync(made).size).padStart(8)}  ${path}  (${verdict})`);
  if (write) {
    mkdirSync(dirname(committed), { recursive: true });
    copyFileSync(made, committed);
  }
}
if (write) console.log(`base fixtures replaced under ${packages}`);
else console.log(differing ? `${differing} file(s) would differ in their streams. Nothing was written.` : "Every file matches the committed fixture's streams. Nothing was written; pass --write to replace the committed files.");
process.exit(!write && differing ? 1 : 0);
