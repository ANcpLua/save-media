/**
 * Encryption declared inside WebM and Matroska data. A track whose frames are
 * encrypted (the WebM layout Widevine uses for VP8, VP9 and AV1) says so in
 * Segment > Tracks > TrackEntry > ContentEncodings > ContentEncoding: a
 * ContentEncodingType of 1 and a ContentEncryption element.
 */

export interface EbmlElementHeader {
  /** The element ID with its length marker, as the Matroska specification writes it (0x1A45DFA3). */
  readonly id: number;
  readonly headerSize: number;
  /** The payload size; null when the element declares an unknown size (live and streamed files). */
  readonly size: number | null;
}

export const MATROSKA_SEGMENT = 0x18538067;
export const MATROSKA_TRACKS = 0x1654ae6b;
export const MATROSKA_CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const CONTENT_ENCODINGS = 0x6d80;
const CONTENT_ENCODING = 0x6240;
const CONTENT_ENCODING_TYPE = 0x5033;
const CONTENT_ENCRYPTION = 0x5035;
/** Masters on the path from the file start to a track's content encodings. */
const PATH = new Set([MATROSKA_SEGMENT, MATROSKA_TRACKS, TRACK_ENTRY, CONTENT_ENCODINGS, CONTENT_ENCODING]);

/** Reads one EBML element header (RFC 8794 variable-size integers); null when it is cut off or invalid. */
export function readEbmlHeader(bytes: Uint8Array, at: number): EbmlElementHeader | null {
  const idLength = vintLength(bytes[at], 4);
  if (!idLength || at + idLength > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[at + i]!;
  const sizeAt = at + idLength;
  const sizeLength = vintLength(bytes[sizeAt], 8);
  if (!sizeLength || sizeAt + sizeLength > bytes.length) return null;
  let size = bytes[sizeAt]! & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = bytes[sizeAt + i]!;
    size = size * 256 + byte;
    unknown &&= byte === 0xff;
  }
  return { id, headerSize: idLength + sizeLength, size: unknown || !Number.isSafeInteger(size) ? null : size };
}

function vintLength(first: number | undefined, max: number): number {
  if (!first) return 0;
  let length = 1;
  while (length <= max && !(first & (0x80 >> (length - 1)))) length++;
  return length > max ? 0 : length;
}

/**
 * Walks a file start, or an element cut from one such as Tracks, to the
 * first Cluster. A truncated tail is ignored: what was read decides.
 */
export function hasMatroskaEncryption(bytes: Uint8Array): boolean {
  return walk(bytes, 0, bytes.length, 0);
}

function walk(bytes: Uint8Array, start: number, end: number, depth: number): boolean {
  for (let at = start; at < end && depth <= 8;) {
    const element = readEbmlHeader(bytes, at);
    if (!element || element.id === MATROSKA_CLUSTER) return false;
    const body = at + element.headerSize;
    const elementEnd = element.size === null ? end : Math.min(end, body + element.size);
    if (element.id === CONTENT_ENCRYPTION) return true;
    if (element.id === CONTENT_ENCODING_TYPE && element.size !== null && element.size <= 8 && body + element.size <= end) {
      let type = 0;
      for (let i = 0; i < element.size; i++) type = type * 256 + bytes[body + i]!;
      if (type === 1) return true;
    }
    if (PATH.has(element.id) && walk(bytes, body, elementEnd, depth + 1)) return true;
    if (element.size === null) return false;
    at = body + element.size;
  }
  return false;
}
