// @vitest-environment node
//
// The e2e media fixtures are binary files. Transport stream segments carry the
// .ts extension, which editors, formatters and language servers take for
// TypeScript. A tool that reads such a file as text and writes it back replaces
// every byte that is not UTF-8 with EF BF BD and breaks every packet; this once
// happened to nine of these files. These checks name the damaged file before an
// e2e run fails somewhere far from the cause. A damaged fixture is regenerated
// with the script that made it (scripts/generate-*.mjs), never edited.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../e2e/media-fixtures");
const PACKET = 188;
const SYNC = 0x47;
/** Three replacement characters in a row: text written over binary bytes, never in a real media file. */
const REWRITTEN_AS_TEXT = Buffer.from("efbfbdefbfbdefbfbd", "hex");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** A segment is AES-128 ciphertext when its folder's playlist says so. */
function encryptedSegment(path: string): boolean {
  const playlist = join(dirname(path), "media.m3u8");
  try {
    return readFileSync(playlist, "utf8").includes("METHOD=AES-128");
  } catch {
    return false;
  }
}

const all = filesUnder(ROOT);
const transportStreams = all.filter(path => path.endsWith(".ts"));

describe("e2e media fixtures", () => {
  it("are present", () => {
    expect(transportStreams.length).toBeGreaterThan(5);
  });

  it.each(all.map(path => [relative(ROOT, path), path] as const))("%s was not written back as text", (_name, path) => {
    expect(readFileSync(path).includes(REWRITTEN_AS_TEXT)).toBe(false);
  });

  it.each(transportStreams.map(path => [relative(ROOT, path), path] as const))("%s is whole: transport packets, or AES-128 blocks", (_name, path) => {
    const bytes = readFileSync(path);
    if (encryptedSegment(path)) {
      expect(bytes.length % 16).toBe(0);
      return;
    }
    expect(bytes.length % PACKET).toBe(0);
    const firstBadPacket = Array.from({ length: bytes.length / PACKET }, (_, index) => index).find(index => bytes[index * PACKET] !== SYNC);
    expect(firstBadPacket).toBeUndefined();
  });
});
