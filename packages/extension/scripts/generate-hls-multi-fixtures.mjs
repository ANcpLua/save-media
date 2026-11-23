#!/usr/bin/env bun
/**
 * Regenerates the committed multi-segment HLS e2e fixtures:
 *
 *   tests/e2e/media-fixtures/hls-multi/       three MPEG-TS segments in the clear
 *   tests/e2e/media-fixtures/hls-aes-multi/   the same three segments under AES-128
 *   tests/e2e/media-fixtures/hls-fmp4-multi/  an init section and three fMP4 segments
 *   tests/e2e/media-fixtures/hls-single-file-fmp4/  one fMP4 file, its header and its
 *                                             three segments listed as byte ranges
 *   tests/e2e/media-fixtures/hls-single-file-ts/    one MPEG-TS file, its three
 *                                             segments listed as byte ranges
 *
 * A single-segment playlist cannot show a dropped, repeated or reordered
 * segment. These fixtures can: the picture is ffmpeg's testsrc2, which
 * changes every frame, each segment is one second of it, and the e2e tests
 * compare the decoded frames of the saved file with the decoded frames of
 * the segments joined in playlist order.
 *
 * The playlists start at EXT-X-MEDIA-SEQUENCE:7, and the AES playlist has no
 * IV attribute: each segment's IV is then its media sequence number (RFC
 * 8216 section 5.2), which is the path a browser run has to cover. The key
 * is a 16-byte file next to the playlist, served in the clear like the
 * existing hls-aes fixture.
 *
 * The single-file fixtures are what a packager writes when it keeps a stream
 * in one file: every part of the playlist is a byte range (EXT-X-BYTERANGE)
 * of that file, and the ranges cover it from its first byte to its last.
 * Saving one must ask for the file once, not once for every range.
 *
 * The fixtures are committed, so tests never depend on ffmpeg for
 * generation. Run this script only when their shape must change. Without
 * arguments it regenerates all of them; `segments` or `single-file` as an
 * argument regenerates that group alone, because ffmpeg versions differ in
 * the bytes they write and a regenerated fixture is a new fixture.
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "tests", "e2e", "media-fixtures");
const FIRST_SEQUENCE = 7;
const SEGMENTS = 3;

const source = [
  "-f", "lavfi", "-i", "testsrc2=duration=3:size=320x180:rate=15",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
  "-map", "0:v:0", "-map", "1:a:0",
  "-c:v", "libx264", "-profile:v", "baseline", "-preset", "veryfast", "-crf", "34",
  "-g", "15", "-keyint_min", "15", "-force_key_frames", "expr:gte(t,n_forced*1)",
  "-c:a", "aac", "-b:a", "32k",
];
const hls = ["-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-start_number", String(FIRST_SEQUENCE)];
const MASTER = (version) => `#EXTM3U
#EXT-X-VERSION:${version}
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,CODECS="avc1.42c00c,mp4a.40.2"
media.m3u8
`;

function fresh(name) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ffmpeg(args) {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
  } catch (error) {
    console.error("multi-segment HLS fixtures not generated: ffmpeg failed or is not installed.");
    process.exit(error?.code === "ENOENT" ? 2 : 1);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function segmentNames(dir, pattern) {
  return readdirSync(dir).filter(name => pattern.test(name)).sort();
}

const GROUPS = { segments: generateSegments, "single-file": generateSingleFiles };
const asked = process.argv.slice(2);
for (const name of asked) {
  if (!(name in GROUPS)) {
    console.error(`unknown fixture group "${name}". Choose from: ${Object.keys(GROUPS).join(", ")}.`);
    process.exit(2);
  }
}
const generated = (asked.length ? asked : Object.keys(GROUPS)).flatMap(name => GROUPS[name]());
for (const dir of generated) {
  for (const name of readdirSync(dir).sort()) console.log(`${String(statSync(join(dir, name)).size).padStart(8)}  ${dir.slice(root.length + 1)}/${name}`);
}
console.log(`HLS fixtures regenerated in ${root}`);

function generateSegments() {
// ---- MPEG-TS, clear ----
const clear = fresh("hls-multi");
ffmpeg([...source, ...hls, "-hls_segment_filename", join(clear, "seg%03d.ts"), join(clear, "media.m3u8")]);
writeFileSync(join(clear, "master.m3u8"), MASTER(3));
const clearPlaylist = readFileSync(join(clear, "media.m3u8"), "utf8");
const transport = segmentNames(clear, /^seg\d+\.ts$/);
assert(transport.length === SEGMENTS, `expected ${SEGMENTS} transport segments, got ${transport.join(", ")}`);
assert(clearPlaylist.includes(`#EXT-X-MEDIA-SEQUENCE:${FIRST_SEQUENCE}`), "the playlist must start at the chosen media sequence");
assert(clearPlaylist.includes("#EXT-X-ENDLIST"), "the playlist must be a finished VOD");

// ---- MPEG-TS, AES-128, IV from the media sequence number ----
const aes = fresh("hls-aes-multi");
// A fixed key keeps the fixture reproducible. It protects nothing: it is served next to the playlist.
const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
writeFileSync(join(aes, "key.bin"), key);
transport.forEach((name, index) => {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(FIRST_SEQUENCE + index, 12);
  const plain = readFileSync(join(clear, name));
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  assert(Buffer.concat([decipher.update(encrypted), decipher.final()]).equals(plain), `${name} must decrypt to its clear segment`);
  writeFileSync(join(aes, name), encrypted);
});
const aesPlaylist = clearPlaylist.replace(/(#EXT-X-PLAYLIST-TYPE:VOD\n)/, '$1#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n');
assert(aesPlaylist.includes("#EXT-X-KEY:") && !/IV=/.test(aesPlaylist), "the AES playlist must name the key and no IV");
writeFileSync(join(aes, "media.m3u8"), aesPlaylist);
writeFileSync(join(aes, "master.m3u8"), MASTER(3));

// ---- fMP4 ----
const fmp4 = fresh("hls-fmp4-multi");
ffmpeg([...source, ...hls, "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
  "-hls_segment_filename", join(fmp4, "seg%03d.m4s"), join(fmp4, "media.m3u8")]);
writeFileSync(join(fmp4, "master.m3u8"), MASTER(7));
const fragments = segmentNames(fmp4, /^seg\d+\.m4s$/);
assert(fragments.length === SEGMENTS, `expected ${SEGMENTS} fMP4 segments, got ${fragments.join(", ")}`);
assert(readFileSync(join(fmp4, "media.m3u8"), "utf8").includes('#EXT-X-MAP:URI="init.mp4"'), "the fMP4 playlist must name its init section");
const sizes = new Set(fragments.map(name => statSync(join(fmp4, name)).size));
assert(sizes.size === SEGMENTS, "the fMP4 segments must differ from each other");

return [clear, aes, fmp4];
}

/** The byte ranges a playlist states, header first, as [offset, length] pairs in playlist order. */
function statedRanges(playlist) {
  const ranges = [];
  let next = 0;
  for (const match of playlist.matchAll(/BYTERANGE[:=]"?(\d+)(?:@(\d+))?/g)) {
    const offset = match[2] === undefined ? next : Number(match[2]);
    ranges.push([offset, Number(match[1])]);
    next = offset + Number(match[1]);
  }
  return ranges;
}

function generateSingleFiles() {
  const dirs = [];
  for (const [name, file, extra, version] of [
    ["hls-single-file-fmp4", "clip.mp4", ["-hls_segment_type", "fmp4"], 7],
    ["hls-single-file-ts", "clip.ts", [], 4],
  ]) {
    const dir = fresh(name);
    // ffmpeg names the one file after -hls_segment_filename and writes it next to the playlist.
    ffmpeg([...source, "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", ...extra,
      "-hls_flags", "single_file", "-hls_segment_filename", join(dir, file), join(dir, "media.m3u8")]);
    writeFileSync(join(dir, "master.m3u8"), MASTER(version));
    const playlist = readFileSync(join(dir, "media.m3u8"), "utf8");
    const size = statSync(join(dir, file)).size;
    const ranges = statedRanges(playlist);
    assert(playlist.includes("#EXT-X-ENDLIST"), `${name}: the playlist must be a finished VOD`);
    assert(readdirSync(dir).sort().join(" ") === [file, "master.m3u8", "media.m3u8"].sort().join(" "), `${name}: expected one media file, got ${readdirSync(dir).join(", ")}`);
    assert(ranges.length === SEGMENTS + (extra.length ? 1 : 0), `${name}: expected a range for ${extra.length ? "the header and " : ""}${SEGMENTS} segments, got ${ranges.length}`);
    let next = 0;
    for (const [offset, length] of ranges) {
      assert(offset === next, `${name}: the range at ${offset} does not follow byte ${next - 1}`);
      next = offset + length;
    }
    assert(next === size, `${name}: the ranges end at byte ${next - 1}, the file at ${size - 1}`);
    dirs.push(dir);
  }
  return dirs;
}
