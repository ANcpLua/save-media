/**
 * Whether the first bytes of an answer begin a whole media file, or only a
 * part of a stream. A page fetches both the same way: a whole file it then
 * plays from memory, and the init sections and fragments it feeds a player
 * piece by piece. Only the first is a file that can be saved by its address.
 *
 * The bytes decide, together with the length the server stated for the
 * whole answer. Nothing is read from the address or the server's type.
 *
 * - MP4 and QuickTime: a part of a stream starts with a segment box (styp,
 *   moof, sidx, emsg, prft), or is an init section: a movie box that
 *   declares fragments (mvex) with nothing after it. A whole file has media
 *   data (mdat) or fragments (moof) of its own, or a movie box that
 *   declares none.
 * - WebM and Matroska: a whole file holds a Cluster, or goes on past the
 *   bytes that were read. An init section ends before its first Cluster.
 * - A transport stream is never taken: a browser plays none from memory, so
 *   a fetched one is a part of a stream.
 */
import type { Container } from "../types/stream";

const SEGMENT_BOXES = new Set(["styp", "moof", "sidx", "emsg", "prft"]);

interface Box { readonly type: string; readonly start: number; readonly body: number; readonly end: number }

/** The boxes between `start` and `end`, as far as their headers are in the bytes. A box may end beyond them. */
function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  for (let offset = start; offset + 8 <= Math.min(end, bytes.length);) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    } else if (size === 0) size = Infinity;
    if (size < header) break;
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    found.push({ type, start: offset, body: offset + header, end: offset + size });
    offset += size;
  }
  return found;
}

function wholeIsoFile(bytes: Uint8Array, totalLength: number | null): boolean {
  const top = boxes(bytes, 0, Infinity);
  if (!top.length || SEGMENT_BOXES.has(top[0]!.type)) return false;
  const types = top.map(box => box.type);
  // Media of its own, in this answer.
  if (types.includes("mdat") || types.includes("moof")) return true;
  const movie = top.find(box => box.type === "moov");
  if (!movie) return false;
  // A movie box that declares no fragments describes media data of this same file.
  if (!boxes(bytes, movie.body, movie.end).some(box => box.type === "mvex")) return true;
  // It declares fragments: a whole file only when something follows it in this answer.
  return totalLength !== null && top.at(-1)!.end < totalLength;
}

const CLUSTER = 0x1f43b675;
const SEGMENT = 0x18538067;

/** An EBML element id or size at `offset`: its value and its length in bytes, or null when the bytes end first. */
function vint(bytes: Uint8Array, offset: number, keepMarker: boolean): { readonly value: number; readonly length: number } | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || offset + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let index = 1; index < length; index++) value = value * 256 + bytes[offset + index]!;
  return { value, length };
}

function wholeMatroskaFile(bytes: Uint8Array, totalLength: number | null): boolean {
  // The answer goes on past what was read: an init section is read whole within these bytes.
  if (totalLength !== null && totalLength > bytes.length) return true;
  // Otherwise every element is here: a whole file has a Cluster among the Segment's children.
  let offset = 0;
  let insideSegment = false;
  while (offset < bytes.length) {
    const id = vint(bytes, offset, true);
    const size = id ? vint(bytes, offset + id.length, false) : null;
    if (!id || !size) return false;
    if (id.value === CLUSTER) return insideSegment;
    offset += id.length + size.length;
    // The Segment is entered, every other element is stepped over.
    if (id.value === SEGMENT) insideSegment = true;
    else offset += size.value;
  }
  return false;
}

/**
 * True when `bytes`, the start of an answer whose whole length is `totalLength` (null when the server
 * stated none), begin a whole file of `container` and not a part of a stream.
 */
export function beginsWholeMediaFile(bytes: Uint8Array, container: Container, totalLength: number | null): boolean {
  if (container === "mp4" || container === "mov" || container === "fmp4" || container === "cmaf") return wholeIsoFile(bytes, totalLength);
  if (container === "webm" || container === "mkv") return wholeMatroskaFile(bytes, totalLength);
  return false;
}
