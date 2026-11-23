#!/usr/bin/env node
/**
 * Regenerates the committed packed-audio HLS e2e fixture:
 *
 *   tests/e2e/media-fixtures/hls-packed-audio/
 *     master.m3u8              a video variant and its audio group
 *     video.m3u8, v007-9.ts    three MPEG-TS segments, picture only
 *     audio.m3u8, a007-9.aac   three packed audio segments (RFC 8216
 *                              section 3.4): bare AAC frames in ADTS, each
 *                              segment opening with an ID3 tag whose PRIV
 *                              frame states the time of its first sample
 *     reference-audio.aac      the same frames in one file without the
 *                              tags. No playlist names it: the tests
 *                              compare the saved sound with it.
 *
 * Joined byte for byte, the audio segments are not one audio stream: a
 * reader of bare frames stops at the second segment's tag. The fixture has
 * three segments so a save that keeps only the first one is caught.
 *
 * The tags carry the clock of the video's transport stream: the first one
 * states the time of the first picture, and each next one is later by the
 * frames before it.
 *
 * The fixture is committed, so tests never depend on ffmpeg for generation.
 * Run this script only when its shape must change: ffmpeg versions differ
 * in the bytes they write, so a regenerated fixture is a new fixture.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "tests", "e2e", "media-fixtures", "hls-packed-audio");
const FIRST_SEQUENCE = 7;
const SEGMENTS = 3;
const SAMPLE_RATE = 44100;
const SAMPLES_PER_FRAME = 1024;
const TICKS_PER_SECOND = 90_000;

function run(bin, args, options = {}) {
  try {
    return execFileSync(bin, args, { encoding: "utf8", ...options });
  } catch (error) {
    console.error(`packed audio fixture not generated: ${bin} failed or is not installed.`);
    process.exit(error?.code === "ENOENT" ? 2 : 1);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ---- video: three one-second transport stream segments, no audio ----
run("ffmpeg", ["-v", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=duration=3:size=320x180:rate=15", "-an",
  "-c:v", "libx264", "-profile:v", "baseline", "-preset", "veryfast", "-crf", "34",
  "-g", "15", "-keyint_min", "15", "-force_key_frames", "expr:gte(t,n_forced*1)",
  "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-start_number", String(FIRST_SEQUENCE),
  "-hls_segment_filename", join(out, "v%03d.ts"), join(out, "video.m3u8")], { stdio: "inherit" });
const videoSegments = readdirSync(out).filter(name => /^v\d+\.ts$/.test(name)).sort();
assert(videoSegments.length === SEGMENTS, `expected ${SEGMENTS} video segments, got ${videoSegments.join(", ")}`);
const firstPicture = Number(JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=start_time", "-of", "json", join(out, videoSegments[0])])).streams[0].start_time);
assert(firstPicture > 0, "the transport stream must not start at time 0, or a lost audio start time would go unnoticed");

// ---- audio: three seconds of AAC in ADTS, cut into segments at frame boundaries ----
const whole = join(out, "reference-audio.aac");
run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=3:sample_rate=${SAMPLE_RATE}`,
  "-c:a", "aac", "-b:a", "32k", "-f", "adts", whole], { stdio: "inherit" });
const adts = readFileSync(whole);
const frames = [];
for (let offset = 0; offset < adts.length;) {
  assert(adts[offset] === 0xff && (adts[offset + 1] & 0xf6) === 0xf0, `no ADTS frame at byte ${offset}`);
  const length = ((adts[offset + 3] & 0x03) << 11) | (adts[offset + 4] << 3) | (adts[offset + 5] >> 5);
  frames.push(adts.subarray(offset, offset + length));
  offset += length;
}
const framesPerSegment = Math.ceil(frames.length / SEGMENTS);

/** The ID3v2.4 tag packed audio opens with: one PRIV frame holding the 33-bit presentation time in eight bytes. */
function timestampTag(seconds) {
  const owner = Buffer.from("com.apple.streaming.transportStreamTimestamp\0", "latin1");
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(Math.round(seconds * TICKS_PER_SECOND)) & 0x1ffffffffn);
  const body = Buffer.concat([owner, time]);
  const syncsafe = value => Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
  const frame = Buffer.concat([Buffer.from("PRIV", "latin1"), syncsafe(body.length), Buffer.from([0, 0]), body]);
  return Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, 0]), syncsafe(frame.length), frame]);
}

const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:1", `#EXT-X-MEDIA-SEQUENCE:${FIRST_SEQUENCE}`, "#EXT-X-PLAYLIST-TYPE:VOD"];
for (let index = 0; index < SEGMENTS; index++) {
  const own = frames.slice(index * framesPerSegment, (index + 1) * framesPerSegment);
  const start = firstPicture + index * framesPerSegment * SAMPLES_PER_FRAME / SAMPLE_RATE;
  const name = `a${String(FIRST_SEQUENCE + index).padStart(3, "0")}.aac`;
  writeFileSync(join(out, name), Buffer.concat([timestampTag(start), ...own]));
  lines.push(`#EXTINF:${(own.length * SAMPLES_PER_FRAME / SAMPLE_RATE).toFixed(6)},`, name);
}
lines.push("#EXT-X-ENDLIST", "");
writeFileSync(join(out, "audio.m3u8"), lines.join("\n"));

writeFileSync(join(out, "master.m3u8"), `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,CODECS="avc1.42c00c,mp4a.40.2",AUDIO="aud"
video.m3u8
`);

for (const name of readdirSync(out).sort()) console.log(`${String(statSync(join(out, name)).size).padStart(8)}  ${name}`);
console.log(`packed audio fixture regenerated in ${out}: ${frames.length} audio frames, first picture at ${firstPicture}s`);
