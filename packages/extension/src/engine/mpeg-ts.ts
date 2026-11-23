import type { JobError } from "@savemedia/core";

/** ISO/IEC 13818-1 transport packets, PAT (table 0) and PMT (table 2). */
export const TS_PACKET_BYTES = 188;
/**
 * Audio and video an MP4 remux copies: H.264, HEVC, MPEG audio, AAC (ADTS), and AC-3 and E-AC-3 as ATSC
 * declares them. DVB declares AC-3 and E-AC-3 as private data with a descriptor (PRIVATE_DATA below).
 */
const MP4_COPY_TYPES = new Set([0x1b, 0x24, 0x03, 0x04, 0x0f, 0x81, 0x87]);
/** PES private data: what it carries is said by a descriptor, if at all. */
const PRIVATE_DATA = 0x06;
/** The descriptors that make private data AC-3 (DVB 0x6a) or E-AC-3 (DVB 0x7a, ATSC 0xcc): audio an MP4 remux copies. */
const AC3_DESCRIPTORS = new Set([0x6a, 0x7a, 0xcc]);
/** Streams an MP4 may leave out: PES metadata such as timed ID3, SCTE-35 cues, private sections and DSM-CC. */
const METADATA_TYPES = new Set([0x15, 0x86, 0x05, 0x0b, 0x0c, 0x0d]);
/** Apple's SAMPLE-AES stream types: H.264, AAC, AC-3 and E-AC-3 whose samples are encrypted. */
const SAMPLE_AES_TYPES = new Set([0xdb, 0xcf, 0xc1, 0xc2]);

function invalid(detail: string): never {
  throw { code: "verification_container", severity: "terminal", probeError: detail } satisfies JobError;
}

function protectedTransport(): never {
  throw { code: "encrypted_media_detected", severity: "terminal", detectedVia: ["mpeg-ts"], keySystem: null } satisfies JobError;
}

/**
 * The whole packets of a segment. A segment that was cut inside its last packet loses that packet, so
 * the packets of the segment after it start where a packet starts.
 */
export function wholePackets(bytes: Uint8Array): Uint8Array {
  const cut = bytes.length % TS_PACKET_BYTES;
  return cut ? bytes.subarray(0, bytes.length - cut) : bytes;
}

function word(data: Uint8Array, at: number): number {
  return (data[at]! << 8) | data[at + 1]!;
}

// PSI can start partway into a packet, continue into another, or carry
// multiple sections in one payload. Only PAT/PMT PIDs allocate this buffer.
//
// A table that arrives damaged (a lost packet, a wrong length, a checksum
// that does not match) is given up, as a decoder gives it up: senders repeat
// their tables, and the next whole one is read. Damage refuses nothing here;
// a stream without any program map that can be read is refused in finish().
class Sections {
  private readonly bytes = new Uint8Array(1024);
  private used = 0;
  private size = 0;

  private drop(): void {
    this.used = 0;
    this.size = 0;
  }

  push(payload: Uint8Array, start: boolean, accept: (section: Uint8Array) => void): void {
    if (!start) {
      if (this.used) this.append(payload, accept);
      return;
    }
    const next = 1 + payload[0]!;
    if (next > payload.length) {
      this.drop();
      return;
    }
    if (this.used) {
      this.append(payload.subarray(1, next), accept);
      // A table that has not ended where the next one starts lost a packet.
      this.drop();
    }
    this.append(payload.subarray(next), accept);
  }

  private append(payload: Uint8Array, accept: (section: Uint8Array) => void): void {
    let pos = 0;
    while (pos < payload.length) {
      if (!this.used && payload[pos] === 0xff) break; // stuffing
      const count = Math.min((this.size || 3) - this.used, payload.length - pos);
      this.bytes.set(payload.subarray(pos, pos + count), this.used);
      this.used += count;
      pos += count;
      if (this.used === 3 && !this.size) {
        this.size = 3 + (word(this.bytes, 1) & 0x0fff);
        // Without a length that can be true, where this table ends is not known: the rest of the payload is left.
        if (this.size < 12 || this.size > this.bytes.length) {
          this.drop();
          return;
        }
      }
      if (this.used === this.size) {
        const section = this.bytes.subarray(0, this.size);
        let crc = 0xffffffff;
        for (const byte of section) {
          crc ^= byte << 24;
          for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
        }
        if (crc === 0 && section[5]! & 1) accept(section); // current_next_indicator
        this.drop();
      }
    }
  }
}

/**
 * A CA_descriptor (tag 9) only names a conditional access system and its
 * ECM/EMM PID (13818-1 2.6.16). Whether payload is scrambled is stated per
 * packet and per PES header, which inspect() reads; the descriptor alone
 * refuses nothing.
 */
function checkDescriptors(section: Uint8Array, start: number, end: number): void {
  if (end > section.length - 4) invalid("Invalid MPEG-TS descriptor length");
  for (let pos = start; pos < end;) {
    if (pos + 2 > end || pos + 2 + section[pos + 1]! > end) invalid("Truncated MPEG-TS descriptor");
    pos += 2 + section[pos + 1]!;
  }
}

/** One of a stream's descriptors (already checked for length) says the stream is AC-3 or E-AC-3. */
function declaresAc3(section: Uint8Array, start: number, end: number): boolean {
  for (let pos = start; pos < end; pos += 2 + section[pos + 1]!) {
    if (AC3_DESCRIPTORS.has(section[pos]!)) return true;
  }
  return false;
}

/**
 * The streams whose PES packets open with the header that states scrambling and times: MPEG audio and
 * video (stream_id 0xC0-0xEF), and private stream 1 and the extended stream id (0xBD, 0xFD), which carry
 * AC-3 and E-AC-3.
 */
function hasPesHeader(streamId: number): boolean {
  return (streamId >= 0xc0 && streamId <= 0xef) || streamId === 0xbd || streamId === 0xfd;
}

/** A PES header of an audio or video stream states PES_scrambling_control. */
function scrambledPes(bytes: Uint8Array, payload: number, end: number): boolean {
  if (payload + 7 > end || bytes[payload] !== 0 || bytes[payload + 1] !== 0 || bytes[payload + 2] !== 1) return false;
  const streamId = bytes[payload + 3]!;
  const flags = bytes[payload + 6]!;
  return hasPesHeader(streamId) && (flags & 0xc0) === 0x80 && (flags & 0x30) !== 0;
}

/**
 * The decoding time a PES header of an audio or video stream states, in 90 kHz ticks: its DTS, or its PTS
 * where it states no DTS (the two are then equal). Null for a header that states neither.
 */
function pesClock(bytes: Uint8Array, payload: number, end: number): number | null {
  if (payload + 14 > end || bytes[payload] !== 0 || bytes[payload + 1] !== 0 || bytes[payload + 2] !== 1) return null;
  const streamId = bytes[payload + 3]!;
  if (!hasPesHeader(streamId) || (bytes[payload + 6]! & 0xc0) !== 0x80) return null;
  const stated = bytes[payload + 7]! >> 6;
  if (!(stated & 2)) return null;
  // A header that states a DTS the packet does not hold in full says nothing here: its PTS is a later time.
  if (stated === 3 && payload + 19 > end) return null;
  const at = stated === 3 ? payload + 14 : payload + 9;
  return ((bytes[at]! >> 1) & 7) * 2 ** 30 + bytes[at + 1]! * 2 ** 22 + (bytes[at + 2]! >> 1) * 2 ** 15 + bytes[at + 3]! * 2 ** 7 + (bytes[at + 4]! >> 1);
}

/** A clock that runs on past the end of its 33 bits starts again from zero: a step back of nearly its whole range. */
const CLOCK_WRAP = 2 ** 32;

export class TransportStreamInspector {
  private readonly pat = new Sections();
  private readonly programs = new Map<number, { number: number; sections: Sections; types: readonly number[] | null }>();
  private readonly streamPids = new Set<number>();
  /** The streams an MP4 remux copies, with the decoding time each stated last. */
  private readonly copied = new Map<number, number | null>();
  private clockRestarted = false;
  private sawProgramMap = false;
  private keepsTransport = false;

  /**
   * Reads every whole packet of `bytes`; bytes after the last whole packet are a packet that was cut short
   * and are passed over. Scrambling refuses the stream. Damage does not: a packet the sender marked as
   * damaged in transit, or whose header cannot be true, is passed over as a player passes over it.
   */
  inspect(bytes: Uint8Array): void {
    for (let offset = 0; offset + TS_PACKET_BYTES <= bytes.length; offset += TS_PACKET_BYTES) {
      const end = offset + TS_PACKET_BYTES;
      if (bytes[offset] !== 0x47) invalid("Damaged MPEG-TS packet");
      // transport_error_indicator: nothing in the packet can be trusted, its header included.
      if (bytes[offset + 1]! & 0x80) continue;
      const pid = word(bytes, offset + 1) & 0x1fff;
      const start = (bytes[offset + 1]! & 0x40) !== 0;
      const flags = bytes[offset + 3]!;
      if (flags & 0xc0) protectedTransport(); // transport_scrambling_control
      const control = (flags >> 4) & 3;
      // A reserved control value, or an adaptation field that runs past the packet: damage.
      if (!control) continue;
      const payload = offset + 4 + ((control & 2) ? 1 + bytes[offset + 4]! : 0);
      if (payload > end || ((control & 1) && payload === end)) continue;
      if (!(control & 1)) continue;
      if (pid === 0) {
        this.pat.push(bytes.subarray(payload, end), start, section => this.readPat(section));
      } else if (this.programs.has(pid)) {
        const program = this.programs.get(pid)!;
        program.sections.push(bytes.subarray(payload, end), start, section => { program.types = this.readPmt(section, program.number); });
      } else if (start && this.streamPids.has(pid)) {
        if (scrambledPes(bytes, payload, end)) protectedTransport();
        if (this.copied.has(pid)) this.noteClock(pid, pesClock(bytes, payload, end));
      }
    }
  }

  /**
   * Within one stretch of a stream, decoding times only go forward (ISO/IEC 13818-1). A step back is the
   * clock starting again: another clip joined in on the server, as playlists mark with EXT-X-DISCONTINUITY.
   */
  private noteClock(pid: number, clock: number | null): void {
    if (clock === null) return;
    const before = this.copied.get(pid) ?? null;
    if (before !== null && clock < before && before - clock < CLOCK_WRAP) this.clockRestarted = true;
    this.copied.set(pid, clock);
  }

  private readPat(section: Uint8Array): void {
    if (section[0] !== 0 || (section.length - 12) % 4) invalid("Invalid MPEG-TS program association table");
    for (let at = 8; at < section.length - 4; at += 4) {
      const number = word(section, at);
      const pid = word(section, at + 2) & 0x1fff;
      if (number && this.programs.get(pid)?.number !== number) {
        this.programs.set(pid, { number, sections: new Sections(), types: null });
      }
    }
    if (this.programs.size > 1) this.keepsTransport = true;
  }

  /** The stream types the program map declares. */
  private readPmt(section: Uint8Array, program: number): number[] {
    const types: number[] = [];
    if (section[0] !== 2 || word(section, 3) !== program || section.length < 16) invalid("Invalid MPEG-TS program map");
    const end = section.length - 4;
    let pos = 12 + (word(section, 10) & 0x0fff);
    checkDescriptors(section, 12, pos);
    while (pos < end) {
      if (pos + 5 > end) invalid("Truncated MPEG-TS stream declaration");
      const type = section[pos]!;
      const pid = word(section, pos + 1) & 0x1fff;
      const next = pos + 5 + (word(section, pos + 3) & 0x0fff);
      checkDescriptors(section, pos + 5, next);
      if (SAMPLE_AES_TYPES.has(type)) protectedTransport();
      types.push(type);
      this.streamPids.add(pid);
      const copies = MP4_COPY_TYPES.has(type) || (type === PRIVATE_DATA && declaresAc3(section, pos + 5, next));
      if (copies && !this.copied.has(pid)) this.copied.set(pid, null);
      // An audio, video or unknown stream an MP4 cannot carry keeps the
      // original packets. Metadata streams may be left out of the MP4.
      if (!copies && !METADATA_TYPES.has(type)) this.keepsTransport = true;
      pos = next;
    }
    this.sawProgramMap = true;
    return types;
  }

  /**
   * `keepsTransport` is true when an MP4 remux would lose a program, an audio
   * or video stream it cannot carry, or a stream of unknown kind, and when
   * the stream's clock starts again part-way: a transport stream may do
   * that, and one MP4 track written by copying its packets may not (the
   * remux then stops, or leaves out what comes after the joint).
   */
  finish(): { keepsTransport: boolean } {
    if (!this.sawProgramMap) invalid("Missing MPEG-TS program map");
    return { keepsTransport: this.keepsTransport || this.clockRestarted };
  }
}
