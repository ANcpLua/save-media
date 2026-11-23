#!/usr/bin/env bun
/**
 * Regenerates the transport stream e2e fixture
 * tests/e2e/media-fixtures/transport/timed-id3.ts: one second of H.264 video
 * and AAC audio in an MPEG transport stream, plus a timed ID3 metadata
 * stream (stream type 0x15 with a metadata descriptor, as HLS packagers
 * write it).
 *
 * The fixture pins two behaviours end to end: a standalone .ts file a page
 * offers is saved byte for byte, and an HLS stream of such segments is
 * remuxed to MP4 with the metadata stream left out.
 *
 * The fixture is committed, so tests never depend on ffmpeg for generation.
 * Run this script only when the fixture's shape must change. Without
 * arguments it writes to a temporary directory and reports how the result
 * compares with the committed file. With --write it replaces the committed
 * file. ffmpeg versions differ in the bytes they write, so a replaced
 * fixture is a new fixture: the e2e tests compare against the file on disk.
 *
 * How it is built:
 *   1. ffmpeg writes video and audio as MPEG-TS (program map on PID 0x1000,
 *      video on 0x100, audio on 0x101: ffmpeg's defaults).
 *   2. This script adds the metadata stream itself, because that keeps the
 *      result independent of how an ffmpeg build handles data streams:
 *      every program map gets an entry for PID 0x102, and one packet with a
 *      PES-wrapped ID3v2.4 tag is inserted after the first program map, with
 *      the presentation time of the first video frame.
 *   3. ffprobe must read back exactly h264, aac and timed_id3.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const committed = resolve(here, "..", "tests", "e2e", "media-fixtures", "transport", "timed-id3.ts");
const write = process.argv.includes("--write");

const PACKET = 188;
const PMT_PID = 0x1000;
const ID3_PID = 0x102;
/** metadata_descriptor for timed ID3: application format "ID3 ", metadata format "ID3 ". */
const ID3_DESCRIPTOR = Buffer.from("260dffff49443320ff49443320000f", "hex");

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
  console.error("transport fixture not generated: ffmpeg and ffprobe were not found. Install ffmpeg or put both on PATH.");
  process.exit(2);
}

/** CRC-32/MPEG-2, the checksum of a transport stream section. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

const pidOf = packet => ((packet[1] & 0x1f) << 8) | packet[2];
const startsUnit = packet => (packet[1] & 0x40) !== 0;

function payloadOffset(packet) {
  const control = (packet[3] >> 4) & 0x3;
  return control === 1 ? 4 : control === 3 ? 5 + packet[4] : PACKET;
}

/** The program map packet with one more stream: the timed ID3 metadata on ID3_PID. */
function withMetadataStream(packet) {
  const at = payloadOffset(packet);
  const sectionStart = at + 1 + packet[at];
  const sectionLength = ((packet[sectionStart + 1] & 0x0f) << 8) | packet[sectionStart + 2];
  const body = packet.subarray(sectionStart, sectionStart + 3 + sectionLength - 4);
  const entry = Buffer.concat([
    Buffer.from([0x15, 0xe0 | (ID3_PID >> 8), ID3_PID & 0xff, 0xf0 | (ID3_DESCRIPTOR.length >> 8), ID3_DESCRIPTOR.length & 0xff]),
    ID3_DESCRIPTOR,
  ]);
  const section = Buffer.concat([body, entry]);
  const length = section.length - 3 + 4;
  section[1] = (section[1] & 0xf0) | (length >> 8);
  section[2] = length & 0xff;
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(section));
  const out = Buffer.alloc(PACKET, 0xff);
  packet.copy(out, 0, 0, sectionStart);
  Buffer.concat([section, checksum]).copy(out, sectionStart);
  if (sectionStart + section.length + 4 > PACKET) throw new Error("the program map no longer fits one packet");
  return out;
}

/** A 33-bit presentation time in the five bytes a PES header gives it. */
function ptsBytes(pts) {
  const value = BigInt(pts);
  return Buffer.from([
    0x21 | Number((value >> 29n) & 0x0en),
    Number((value >> 22n) & 0xffn),
    0x01 | Number((value >> 14n) & 0xfen),
    Number((value >> 7n) & 0xffn),
    0x01 | Number((value << 1n) & 0xfen),
  ]);
}

const syncsafe = size => Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);

/** An ID3v2.4 tag with one title frame. */
function id3Tag(title) {
  const text = Buffer.concat([Buffer.from([0x03]), Buffer.from(title, "utf8")]);
  const frame = Buffer.concat([Buffer.from("TIT2"), syncsafe(text.length), Buffer.from([0x00, 0x00]), text]);
  return Buffer.concat([Buffer.from("ID3"), Buffer.from([0x04, 0x00, 0x00]), syncsafe(frame.length), frame]);
}

/** One transport packet that carries the whole metadata PES, padded in its adaptation field. */
function metadataPacket(pts) {
  const tag = id3Tag("savemedia fixture");
  const header = Buffer.concat([Buffer.from([0x80, 0x80, 0x05]), ptsBytes(pts)]);
  const length = header.length + tag.length;
  const pes = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0xbd, length >> 8, length & 0xff]), header, tag]);
  const stuffing = PACKET - 4 - 1 - pes.length;
  if (stuffing < 1) throw new Error("the metadata does not fit one packet");
  const out = Buffer.alloc(PACKET, 0xff);
  out[0] = 0x47;
  out[1] = 0x40 | (ID3_PID >> 8);
  out[2] = ID3_PID & 0xff;
  out[3] = 0x30;
  out[4] = stuffing;
  out[5] = 0x00;
  pes.copy(out, PACKET - pes.length);
  return out;
}

const work = mkdtempSync(join(tmpdir(), "savemedia-transport-fixture-"));
try {
  const base = join(work, "base.ts");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=duration=1:size=160x90:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "15",
    "-c:a", "aac", "-b:a", "32k",
    "-f", "mpegts", base], { stdio: ["ignore", "inherit", "inherit"] });

  const firstVideoPts = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=start_pts", "-of", "json", base], { encoding: "utf8" })).streams[0].start_pts;

  const source = readFileSync(base);
  if (source.length % PACKET !== 0) throw new Error("ffmpeg wrote something that is not a whole number of transport packets");
  const packets = [];
  let inserted = false;
  for (let offset = 0; offset < source.length; offset += PACKET) {
    const packet = source.subarray(offset, offset + PACKET);
    if (packet[0] !== 0x47) throw new Error(`no sync byte at ${offset}`);
    if (pidOf(packet) === ID3_PID) throw new Error("the base stream already uses the metadata PID");
    if (pidOf(packet) === PMT_PID && startsUnit(packet)) {
      packets.push(withMetadataStream(packet));
      if (!inserted) {
        packets.push(metadataPacket(firstVideoPts));
        inserted = true;
      }
    } else packets.push(packet);
  }
  if (!inserted) throw new Error("the base stream has no program map on PID 0x1000");

  const output = join(work, "timed-id3.ts");
  writeFileSync(output, Buffer.concat(packets));

  const codecs = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", output],
    { encoding: "utf8" })).streams.map(stream => stream.codec_name);
  if (codecs.join(",") !== "h264,aac,timed_id3") {
    throw new Error(`ffprobe reads ${codecs.join(",") || "nothing"} from the result, expected h264,aac,timed_id3`);
  }

  const bytes = readFileSync(output);
  const digest = createHash("sha256").update(bytes).digest("hex");
  console.log(`timed-id3.ts: ${bytes.length} bytes, ${bytes.length / PACKET} packets, sha256 ${digest}`);
  if (existsSync(committed)) {
    const current = readFileSync(committed);
    console.log(current.equals(bytes) ? "identical to the committed fixture"
      : `differs from the committed fixture (${current.length} bytes, sha256 ${createHash("sha256").update(current).digest("hex")})`);
  }
  if (write) {
    mkdirSync(dirname(committed), { recursive: true });
    writeFileSync(committed, bytes);
    console.log(`wrote ${committed}`);
  } else {
    console.log("not written: pass --write to replace the committed fixture");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
