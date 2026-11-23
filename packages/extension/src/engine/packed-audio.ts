/**
 * Packed audio (RFC 8216 section 3.4): an HLS audio rendition whose segments
 * are bare audio frames, AAC in ADTS or MP3, in no container. Every segment
 * opens with an ID3 tag whose PRIV frame states when its first sample plays,
 * on the clock of the video's transport stream.
 *
 * Joined byte for byte, such segments are not one audio stream: a reader of
 * bare frames stops at the first tag that is not at the very start, and the
 * saved file would carry the sound of the first segment only. So the tags
 * are taken out here, the frames are kept, and the first tag's time is
 * handed on, because bare frames carry no clock of their own.
 *
 * Only bytes decide: the "ID3" tag header, the frame sync words and the
 * lengths the frames state.
 */

const ID3_HEADER_BYTES = 10;
const ADTS_HEADER_BYTES = 7;
const TIMESTAMP_OWNER = "com.apple.streaming.transportStreamTimestamp";
/** MPEG-2 presentation times count 90000 ticks a second in 33 bits. */
const TICKS_PER_SECOND = 90_000;

/**
 * The length of the ID3v2 tag that starts at `offset`: its header, its body
 * and its footer when it has one. 0 when no tag starts there, or when fewer
 * than the ten header bytes are left.
 */
export function id3TagLength(bytes: Uint8Array, offset = 0): number {
  if (offset + ID3_HEADER_BYTES > bytes.length) return 0;
  if (bytes[offset] !== 0x49 || bytes[offset + 1] !== 0x44 || bytes[offset + 2] !== 0x33) return 0;
  if (bytes[offset + 3] === 0xff || bytes[offset + 4] === 0xff) return 0;
  const size = bytes.subarray(offset + 6, offset + 10);
  // The size is four 7-bit bytes, so a tag can never look like a frame sync.
  if (size.some(byte => byte & 0x80)) return 0;
  const body = (size[0]! << 21) | (size[1]! << 14) | (size[2]! << 7) | size[3]!;
  const footer = bytes[offset + 5]! & 0x10 ? ID3_HEADER_BYTES : 0;
  return ID3_HEADER_BYTES + body + footer;
}

/**
 * The time a tag's PRIV frame states for the first sample that follows it,
 * in seconds: eight bytes, big-endian, of which the low 33 bits are the
 * MPEG-2 presentation time. Null when the tag names no such time.
 */
function transportTimestampSeconds(tag: Uint8Array): number | null {
  const version = tag[3]!;
  if (version !== 3 && version !== 4) return null;
  const end = tag.length - (tag[5]! & 0x10 ? ID3_HEADER_BYTES : 0);
  for (let offset = ID3_HEADER_BYTES; offset + ID3_HEADER_BYTES <= end;) {
    const id = String.fromCharCode(tag[offset]!, tag[offset + 1]!, tag[offset + 2]!, tag[offset + 3]!);
    if (id === "\0\0\0\0") return null;
    const raw = tag.subarray(offset + 4, offset + 8);
    // ID3v2.4 writes frame sizes as 7-bit bytes, ID3v2.3 as a plain number.
    const size = version === 4
      ? (raw[0]! << 21) | (raw[1]! << 14) | (raw[2]! << 7) | raw[3]!
      : ((raw[0]! << 24) | (raw[1]! << 16) | (raw[2]! << 8) | raw[3]!) >>> 0;
    const body = offset + ID3_HEADER_BYTES;
    if (size <= 0 || body + size > end) return null;
    if (id === "PRIV") {
      const ownerEnd = tag.indexOf(0, body);
      if (ownerEnd > body && ownerEnd < body + size
        && String.fromCharCode(...tag.subarray(body, ownerEnd)) === TIMESTAMP_OWNER && body + size - (ownerEnd + 1) === 8) {
        const value = tag.subarray(ownerEnd + 1, ownerEnd + 9);
        // 33 bits: one bit of the fourth byte, then the last four bytes.
        const ticks = (value[3]! & 1) * 2 ** 32 + (((value[4]! << 24) | (value[5]! << 16) | (value[6]! << 8) | value[7]!) >>> 0);
        return ticks / TICKS_PER_SECOND;
      }
    }
    offset = body + size;
  }
  return null;
}

/** The 12-bit sync word with layer 0: the header of an AAC frame in ADTS. */
function isAdtsFrame(bytes: Uint8Array, offset: number): boolean {
  return offset + 1 < bytes.length && bytes[offset] === 0xff && (bytes[offset + 1]! & 0xf6) === 0xf0;
}

/** The 11-bit sync word with a layer and a version in use: the header of an MPEG audio (MP3) frame. */
function isMpegAudioFrame(bytes: Uint8Array, offset: number): boolean {
  if (offset + 1 >= bytes.length || bytes[offset] !== 0xff) return false;
  const second = bytes[offset + 1]!;
  return (second & 0xe0) === 0xe0 && (second & 0x06) !== 0 && (second & 0x18) !== 0x08;
}

/** What a track's first segment says it is, and when its first sample plays when a tag states that. */
export interface PackedAudioHead {
  readonly frames: "adts" | "mpeg";
  /** Seconds on the transport stream's clock; null when no tag states the time. */
  readonly startSeconds: number | null;
}

/**
 * Reads the start of a track's first segment (or of a one-file track): the
 * tags it opens with and the frame that follows them. Null when what follows
 * is no bare audio frame, which leaves the bytes to the other checks.
 */
export function packedAudioHead(bytes: Uint8Array): PackedAudioHead | null {
  let offset = 0;
  let startSeconds: number | null = null;
  for (let length = id3TagLength(bytes, offset); length > 0; length = id3TagLength(bytes, offset)) {
    if (offset + length <= bytes.length) startSeconds ??= transportTimestampSeconds(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (isAdtsFrame(bytes, offset)) return { frames: "adts", startSeconds };
  if (isMpegAudioFrame(bytes, offset)) return { frames: "mpeg", startSeconds };
  return null;
}

/**
 * The frames of a packed audio track, segment by segment, without the tags.
 * `push` returns the audio bytes of one more segment, or null when the
 * segment holds bytes that are neither a tag nor a frame, so the track cannot
 * be read as audio. A frame or a tag that a segment cuts off is completed by
 * the next one.
 */
export class PackedAudioFrames {
  private carry: Uint8Array = new Uint8Array(0);

  constructor(private readonly frames: PackedAudioHead["frames"]) {}

  push(segment: Uint8Array): Uint8Array | null {
    const bytes = this.carry.length ? joined(this.carry, segment) : segment;
    this.carry = new Uint8Array(0);
    return this.frames === "adts" ? this.adts(bytes) : this.afterTags(bytes);
  }

  /** MP3 frames state no length that is read here: the tags a segment opens with are taken off, and the reader finds every frame's sync itself. */
  private afterTags(bytes: Uint8Array): Uint8Array | null {
    let offset = 0;
    for (let length = id3TagLength(bytes, offset); length > 0; length = id3TagLength(bytes, offset)) offset += length;
    if (offset > bytes.length) {
      this.carry = bytes;
      return new Uint8Array(0);
    }
    return bytes.subarray(offset);
  }

  /** Every ADTS frame states its own length, so the segment is walked frame by frame and each tag between frames is left out. */
  private adts(bytes: Uint8Array): Uint8Array | null {
    const kept: Uint8Array[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const left = bytes.length - offset;
      const tag = id3TagLength(bytes, offset);
      let length = tag;
      if (tag === 0) {
        // Too few bytes to tell a tag or a frame header: the next segment completes them.
        const cutTag = left < ID3_HEADER_BYTES && startsLikeTag(bytes, offset);
        const cutFrame = left < ADTS_HEADER_BYTES && bytes[offset] === 0xff && (left < 2 || isAdtsFrame(bytes, offset));
        if (cutTag || cutFrame) break;
        if (!isAdtsFrame(bytes, offset)) return null;
        length = ((bytes[offset + 3]! & 0x03) << 11) | (bytes[offset + 4]! << 3) | (bytes[offset + 5]! >> 5);
        if (length < ADTS_HEADER_BYTES) return null;
      }
      if (length > left) break;
      if (tag === 0) kept.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
    this.carry = bytes.slice(offset);
    return joined(...kept);
  }
}

function startsLikeTag(bytes: Uint8Array, offset: number): boolean {
  const marker = [0x49, 0x44, 0x33];
  for (let index = 0; index < marker.length && offset + index < bytes.length; index++) {
    if (bytes[offset + index] !== marker[index]) return false;
  }
  return true;
}

function joined(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
