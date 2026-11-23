#!/usr/bin/env node
/**
 * Regenerates the two transport stream fixtures with AC-3 family sound in
 * tests/e2e/media-fixtures/transport/:
 *
 *   h264-ac3.ts   one second of H.264 video and AC-3 sound, the sound
 *                 declared as ATSC declares it (stream type 0x81);
 *   h264-eac3.ts  the same with E-AC-3 sound, declared as DVB declares it
 *                 (stream type 0x06, private data, with the enhanced AC-3
 *                 descriptor 0x7a).
 *
 * They pin one behaviour: an HLS stream of such segments becomes an MP4 with
 * its picture and its sound, because the MP4 the engine writes can carry
 * both. Before, such a stream was kept as a .ts file.
 *
 * The fixtures are committed, so tests never depend on ffmpeg. Run this
 * script only when a fixture's shape must change. Without arguments it
 * writes to a temporary directory and reports how each result compares with
 * the committed file. With --write it replaces the committed files. ffmpeg
 * versions differ in the bytes they write, so a replaced fixture is a new
 * fixture.
 *
 * These files are MPEG transport streams with a .ts extension: binary, never
 * to be opened, formatted or written as text.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const folder = resolve(here, "..", "tests", "e2e", "media-fixtures", "transport");
const write = process.argv.includes("--write");
const PACKET = 188;

function findExecutable(name, candidates) {
  for (const candidate of [name, ...candidates]) {
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore" });
      return candidate;
    } catch { /* try the next place */ }
  }
  return null;
}

const ffmpeg = findExecutable("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
const ffprobe = findExecutable("ffprobe", ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]);
if (!ffmpeg || !ffprobe) {
  console.error("AC-3 transport fixtures not generated: ffmpeg and ffprobe were not found. Install ffmpeg or put both on PATH.");
  process.exit(2);
}

/** The stream types the first program map on PID 0x1000 declares, each with its descriptor tags. */
function declaredStreams(bytes) {
  for (let offset = 0; offset < bytes.length; offset += PACKET) {
    const packet = bytes.subarray(offset, offset + PACKET);
    if ((((packet[1] & 0x1f) << 8) | packet[2]) !== 0x1000 || !(packet[1] & 0x40)) continue;
    const section = packet.subarray(5 + packet[4]);
    const end = 3 + (((section[1] & 0x0f) << 8) | section[2]) - 4;
    const streams = [];
    for (let pos = 12 + (((section[10] & 0x0f) << 8) | section[11]); pos < end;) {
      const next = pos + 5 + (((section[pos + 3] & 0x0f) << 8) | section[pos + 4]);
      const tags = [];
      for (let at = pos + 5; at < next; at += 2 + section[at + 1]) tags.push(section[at]);
      streams.push({ type: section[pos], tags });
      pos = next;
    }
    return streams;
  }
  throw new Error("no program map found");
}

const FIXTURES = [
  { name: "h264-ac3.ts", codec: "ac3", flags: [], probe: "h264,ac3", declares: stream => stream.type === 0x81 },
  { name: "h264-eac3.ts", codec: "eac3", flags: ["-mpegts_flags", "system_b"], probe: "h264,eac3",
    declares: stream => stream.type === 0x06 && stream.tags.includes(0x7a) },
];

const work = mkdtempSync(join(tmpdir(), "savemedia-ac3-fixtures-"));
try {
  for (const fixture of FIXTURES) {
    const out = join(work, fixture.name);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "1", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "10",
      "-c:a", fixture.codec, "-b:a", "96k", "-ac", "2",
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
      ...fixture.flags, "-f", "mpegts", out], { stdio: "inherit" });
    const bytes = readFileSync(out);
    if (bytes.length % PACKET) throw new Error(`${fixture.name}: not whole transport packets`);
    // ffprobe lists a program's streams twice: once under the program, once by themselves.
    const codecs = [...new Set(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", out], { encoding: "utf8" })
      .trim().split(/\s+/))].join(",");
    if (codecs !== fixture.probe) throw new Error(`${fixture.name}: ffprobe reads ${codecs}, expected ${fixture.probe}`);
    const streams = declaredStreams(bytes);
    if (!streams.some(fixture.declares)) throw new Error(`${fixture.name}: the program map does not declare the sound as expected: ${JSON.stringify(streams)}`);
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const target = join(folder, fixture.name);
    const same = existsSync(target) && readFileSync(target).equals(bytes);
    if (write) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(target, bytes);
      console.log(`${fixture.name}: written, ${bytes.length} bytes, sha256 ${digest}`);
    } else {
      console.log(`${fixture.name}: ${bytes.length} bytes, sha256 ${digest}, ${same ? "identical to" : existsSync(target) ? "differs from" : "no"} committed file`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
