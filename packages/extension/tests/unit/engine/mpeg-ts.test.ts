import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TransportStreamInspector, TS_PACKET_BYTES } from "../../../src/engine/mpeg-ts";
import { addCaDescriptor, pid, replaceStreamType, withProgramMap } from "./helpers/transport";

const fixture = (path: string) => new Uint8Array(readFileSync(resolve(__dirname, "../../e2e/media-fixtures", path)));
// H.264 (0x1b), AAC (0x0f) and timed ID3 (0x15) in one program whose PMT is on PID 0x1000.
const muxed = fixture("transport/timed-id3.ts");
const plain = fixture("hls/seg000.ts");
function inspect(bytes: Uint8Array) {
  const ts = new TransportStreamInspector();
  ts.inspect(bytes);
  return ts.finish();
}

describe("MPEG transport streams", () => {
  it("lets an MP4 remux drop metadata streams but keeps a stream MP4 cannot carry", () => {
    expect(inspect(plain).keepsTransport).toBe(false);
    expect(inspect(muxed).keepsTransport).toBe(false);
    // A stream of a kind this reader does not know (0x90) in place of AAC: the remux would lose it.
    expect(inspect(withProgramMap(muxed, replaceStreamType(0x0f, 0x90))).keepsTransport).toBe(true);
    const ts = new TransportStreamInspector();
    ts.inspect(plain);
    ts.inspect(withProgramMap(muxed, replaceStreamType(0x15, 0x06)));
    expect(ts.finish().keepsTransport).toBe(true);
  });

  it("leaves AC-3 and E-AC-3 sound to the MP4 remux, however the program map declares it", () => {
    // ATSC: stream types 0x81 and 0x87.
    expect(inspect(fixture("transport/h264-ac3.ts")).keepsTransport).toBe(false);
    expect(inspect(withProgramMap(fixture("transport/h264-ac3.ts"), replaceStreamType(0x81, 0x87))).keepsTransport).toBe(false);
    // DVB: private data (0x06) with the enhanced AC-3 descriptor (0x7a), or the AC-3 descriptor (0x6a).
    const dvb = fixture("transport/h264-eac3.ts");
    expect(inspect(dvb).keepsTransport).toBe(false);
    const withDescriptor = (from: number, to: number) => (section: number[]): number[] => {
      const next = section.slice();
      for (let pos = 12 + (((next[10]! & 15) << 8) | next[11]!); pos + 5 <= next.length;) {
        const end = pos + 5 + (((next[pos + 3]! & 15) << 8) | next[pos + 4]!);
        for (let at = pos + 5; at < end; at += 2 + next[at + 1]!) if (next[at] === from) next[at] = to;
        pos = end;
      }
      return next;
    };
    expect(inspect(withProgramMap(dvb, withDescriptor(0x7a, 0x6a))).keepsTransport).toBe(false);
    expect(inspect(withProgramMap(dvb, withDescriptor(0x7a, 0xcc))).keepsTransport).toBe(false);
    // Private data whose descriptors name no sound an MP4 carries keeps the packets.
    expect(inspect(withProgramMap(dvb, withDescriptor(0x7a, 0x59))).keepsTransport).toBe(true);
  });

  it("refuses AC-3 sound whose PES header declares scrambled payload", () => {
    const scrambled = fixture("transport/h264-ac3.ts");
    let changed = false;
    for (let offset = 0; offset < scrambled.length && !changed; offset += TS_PACKET_BYTES) {
      const packet = scrambled.subarray(offset, offset + TS_PACKET_BYTES);
      if (pid(packet) !== 0x101 || !(packet[1]! & 0x40)) continue;
      const payload = 4 + (packet[3]! & 0x20 ? 1 + packet[4]! : 0);
      // AC-3 travels in private stream 1.
      expect([...packet.subarray(payload, payload + 4)]).toEqual([0, 0, 1, 0xbd]);
      packet[payload + 6] = packet[payload + 6]! | 0x10;
      changed = true;
    }
    expect(changed).toBe(true);
    expect(() => inspect(scrambled)).toThrow(expect.objectContaining({ code: "encrypted_media_detected" }));
  });

  // Decoding times only go forward inside one stretch of a stream. A step back is another clip joined in.
  describe("a clock that starts again", () => {
    const parts = ["seg007.ts", "seg008.ts", "seg009.ts"].map(name => fixture(`hls-multi/${name}`));
    const through = (...segments: Uint8Array[]) => {
      const ts = new TransportStreamInspector();
      for (const segment of segments) ts.inspect(segment);
      return ts.finish().keepsTransport;
    };

    it("leaves every stream whose clock runs on to the MP4 remux", () => {
      expect(through(...parts)).toBe(false);
      for (const single of [plain, muxed, fixture("hls-single-file-ts/clip.ts"), fixture("hls-packed-audio/v007.ts")]) expect(through(single)).toBe(false);
      expect(through(fixture("hls-packed-audio/v007.ts"), fixture("hls-packed-audio/v008.ts"), fixture("hls-packed-audio/v009.ts"))).toBe(false);
    });

    it("keeps the transport stream when a stream's decoding time steps back, wherever the joint is", () => {
      expect(through(...parts, ...parts)).toBe(true);
      expect(through(parts[2]!, parts[0]!)).toBe(true);
      expect(through(plain, plain)).toBe(true);
      expect(through(parts[0]!, parts[2]!, parts[1]!)).toBe(true);
      // A jump forward is no restart: one clock, with a stretch missing.
      expect(through(parts[0]!, parts[2]!)).toBe(false);
    });

    it("does not take the 33-bit clock running over for a restart", () => {
      // Sets every PES time of the segment to `ticks` past its own, modulo 2^33, as a long-running encoder states them.
      const shifted = (segment: Uint8Array, ticks: number): Uint8Array => {
        const out = segment.slice();
        const write = (at: number, marker: number, value: number): void => {
          out[at] = (marker << 4) | (Math.floor(value / 2 ** 30) % 8 << 1) | 1;
          out[at + 1] = Math.floor(value / 2 ** 22) % 256;
          out[at + 2] = (Math.floor(value / 2 ** 15) % 128 << 1) | 1;
          out[at + 3] = Math.floor(value / 2 ** 7) % 256;
          out[at + 4] = (value % 128 << 1) | 1;
        };
        const read = (at: number): number => ((out[at]! >> 1) & 7) * 2 ** 30 + out[at + 1]! * 2 ** 22 + (out[at + 2]! >> 1) * 2 ** 15 + out[at + 3]! * 2 ** 7 + (out[at + 4]! >> 1);
        for (let offset = 0; offset < out.length; offset += TS_PACKET_BYTES) {
          if (!(out[offset + 1]! & 0x40)) continue;
          const control = (out[offset + 3]! >> 4) & 3;
          const payload = offset + 4 + ((control & 2) ? 1 + out[offset + 4]! : 0);
          if (!(control & 1) || payload + 19 > offset + TS_PACKET_BYTES || out[payload] !== 0 || out[payload + 1] !== 0 || out[payload + 2] !== 1) continue;
          if (out[payload + 3]! < 0xc0 || out[payload + 3]! > 0xef) continue;
          const stated = out[payload + 7]! >> 6;
          if (stated & 2) write(payload + 9, stated, (read(payload + 9) + ticks) % 2 ** 33);
          if (stated === 3) write(payload + 14, 1, (read(payload + 14) + ticks) % 2 ** 33);
        }
        return out;
      };
      // The same shift is no restart, and a clock that passes 2^33 between two segments is none either.
      const nearEnd = 2 ** 33 - 90_000 * 3;
      expect(through(shifted(parts[0]!, 1000), shifted(parts[1]!, 1000), shifted(parts[2]!, 1000))).toBe(false);
      expect(through(shifted(parts[0]!, nearEnd), shifted(parts[1]!, nearEnd), shifted(parts[2]!, nearEnd))).toBe(false);
      // A real step back by the same test.
      expect(through(shifted(parts[0]!, 90_000 * 60), parts[1]!)).toBe(true);
    });
  });

  it("reads a PMT split across packets, including a nonzero pointer field", () => {
    const source = withProgramMap(muxed, replaceStreamType(0x0f, 0x90));
    const ts = new TransportStreamInspector();
    let programSeen = false;
    for (let offset = 0; offset < source.length; offset += TS_PACKET_BYTES) {
      const packet = source.subarray(offset, offset + TS_PACKET_BYTES);
      if (pid(packet) === 0x1000) {
        if (programSeen) continue;
        programSeen = true;
        const section = packet.subarray(5, 8 + (packet[7]! | ((packet[6]! & 15) << 8)));
        const first = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
        first.set([0x47, 0x50, 0x00, 0x30, 174, 0]);
        first.set([2, 0xff, 0xff, ...section.slice(0, 6)], 179);
        const second = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
        second.set([0x47, 0x10, 0x00, 0x11, ...section.slice(6)]);
        ts.inspect(first);
        ts.inspect(second);
      } else ts.inspect(packet);
    }
    expect(ts.finish().keepsTransport).toBe(true);
  });

  it("accepts clear packets beside a conditional access descriptor", () => {
    const declared = withProgramMap(muxed, addCaDescriptor);
    expect(declared).not.toEqual(muxed);
    expect(inspect(declared)).toEqual({ keepsTransport: false });
  });

  it.each([[0x1b, 0xdb], [0x0f, 0xcf]])("refuses a stream declared as SAMPLE-AES (stream type %i becomes %i)", (from, to) => {
    expect(() => inspect(withProgramMap(muxed, replaceStreamType(from, to))))
      .toThrow(expect.objectContaining({ code: "encrypted_media_detected", detectedVia: ["mpeg-ts"] }));
  });

  it("refuses a PES header that declares scrambled payload", () => {
    const scrambled = muxed.slice();
    for (let offset = 0; offset < scrambled.length; offset += TS_PACKET_BYTES) {
      const packet = scrambled.subarray(offset, offset + TS_PACKET_BYTES);
      if (pid(packet) !== 0x100 || !(packet[1]! & 0x40)) continue;
      const payload = 4 + (packet[3]! & 0x20 ? 1 + packet[4]! : 0);
      expect([...packet.subarray(payload, payload + 3)]).toEqual([0, 0, 1]);
      packet[payload + 6] = packet[payload + 6]! | 0x10;
      break;
    }
    expect(() => inspect(scrambled)).toThrow(expect.objectContaining({ code: "encrypted_media_detected" }));
  });

  it("refuses a scrambled packet, and at its end only a stream without a program map", () => {
    const scrambled = muxed.slice();
    scrambled[3] = scrambled[3]! | 0x80;
    expect(() => inspect(scrambled)).toThrow(expect.objectContaining({ code: "encrypted_media_detected" }));
    // Which of the streams its program map lists arrived is not asked.
    const part = new TransportStreamInspector();
    for (let off = 0; off < muxed.length; off += TS_PACKET_BYTES) {
      const packet = muxed.subarray(off, off + TS_PACKET_BYTES);
      if (pid(packet) !== 0x100) part.inspect(packet);
    }
    expect(part.finish()).toEqual({ keepsTransport: false });
  });

  // Damage is not encryption: a player plays through it, and so the stream is saved.
  describe("a stream with damage that is no scrambling", () => {
    const packets = (bytes: Uint8Array) => Array.from({ length: bytes.length / TS_PACKET_BYTES }, (_, index) => bytes.subarray(index * TS_PACKET_BYTES, (index + 1) * TS_PACKET_BYTES));
    const firstOf = (bytes: Uint8Array, wanted: number, from = 0) => packets(bytes).findIndex((packet, index) => index >= from && pid(packet) === wanted);

    it("passes over a packet the sender marked as damaged in transit", () => {
      const marked = muxed.slice();
      const video = firstOf(marked, 0x100, 20);
      marked[video * TS_PACKET_BYTES + 1] = marked[video * TS_PACKET_BYTES + 1]! | 0x80;
      expect(inspect(marked)).toEqual({ keepsTransport: false });
      // Its header is not trusted either: scrambling bits in it say nothing.
      marked[video * TS_PACKET_BYTES + 3] = marked[video * TS_PACKET_BYTES + 3]! | 0x80;
      expect(inspect(marked)).toEqual({ keepsTransport: false });
    });

    it("still refuses scrambling on a clean packet beside a marked one", () => {
      const both = muxed.slice();
      const video = firstOf(both, 0x100, 20);
      both[video * TS_PACKET_BYTES + 1] = both[video * TS_PACKET_BYTES + 1]! | 0x80;
      const clean = firstOf(both, 0x100, video + 1);
      both[clean * TS_PACKET_BYTES + 3] = both[clean * TS_PACKET_BYTES + 3]! | 0x80;
      expect(() => inspect(both)).toThrow(expect.objectContaining({ code: "encrypted_media_detected" }));
    });

    it("passes over a last packet that was cut short", () => {
      expect(inspect(muxed.slice(0, -100))).toEqual({ keepsTransport: false });
      expect(inspect(muxed.slice(0, -1))).toEqual({ keepsTransport: false });
      // Read in blocks, as a file is: a last block shorter than one packet holds nothing.
      const ts = new TransportStreamInspector();
      ts.inspect(muxed);
      ts.inspect(muxed.slice(0, 40));
      ts.inspect(new Uint8Array(0));
      expect(ts.finish()).toEqual({ keepsTransport: false });
    });

    it("gives up a program map whose checksum does not match and reads the next whole one", () => {
      const flipped = muxed.slice();
      const map = firstOf(flipped, 0x1000);
      expect(firstOf(flipped, 0x1000, map + 1)).toBeGreaterThan(map);
      flipped[map * TS_PACKET_BYTES + 15] = flipped[map * TS_PACKET_BYTES + 15]! ^ 1;
      expect(inspect(flipped)).toEqual({ keepsTransport: false });
      // The same for a table whose length field cannot be true, and one whose pointer leaves the packet.
      const length = muxed.slice();
      length[map * TS_PACKET_BYTES + 6] = 0xff;
      length[map * TS_PACKET_BYTES + 7] = 0xff;
      expect(inspect(length)).toEqual({ keepsTransport: false });
      const pointer = muxed.slice();
      pointer[map * TS_PACKET_BYTES + 4] = 0xff;
      expect(inspect(pointer)).toEqual({ keepsTransport: false });
    });

    it("gives up a table that never ended (a packet of it was lost) when the next one starts", () => {
      const ts = new TransportStreamInspector();
      const all = packets(muxed);
      const map = firstOf(muxed, 0x1000);
      // The start of a program map whose second packet never arrives: a pointer of 0, then six bytes of a longer table.
      const opening = new Uint8Array(TS_PACKET_BYTES).fill(0xff);
      const section = all[map]!.subarray(5, 8 + (all[map]![7]! | ((all[map]![6]! & 15) << 8)));
      opening.set([0x47, 0x50, 0x00, 0x30, 176, 0], 0);
      opening.set([0, ...section.slice(0, 6)], 181);
      for (const [index, packet] of all.entries()) {
        if (index === map) ts.inspect(opening);
        ts.inspect(packet);
      }
      expect(ts.finish()).toEqual({ keepsTransport: false });
      // A stream that ends inside a table is not refused for that either.
      const cut = new TransportStreamInspector();
      cut.inspect(muxed);
      cut.inspect(opening);
      expect(cut.finish()).toEqual({ keepsTransport: false });
    });

    it("passes over a packet with a reserved control value or an adaptation field that runs past it", () => {
      const reserved = muxed.slice();
      const video = firstOf(reserved, 0x100, 20);
      reserved[video * TS_PACKET_BYTES + 3] = reserved[video * TS_PACKET_BYTES + 3]! & 0x0f;
      expect(inspect(reserved)).toEqual({ keepsTransport: false });
      const overrun = muxed.slice();
      overrun[video * TS_PACKET_BYTES + 3] = (overrun[video * TS_PACKET_BYTES + 3]! & 0x0f) | 0x30;
      overrun[video * TS_PACKET_BYTES + 4] = 250;
      expect(inspect(overrun)).toEqual({ keepsTransport: false });
    });

    it("refuses a stream in which no program map can be read at all", () => {
      const none = muxed.slice();
      for (const [index, packet] of packets(none).entries()) {
        if (pid(packet) === 0x1000 && packet[1]! & 0x40) none[index * TS_PACKET_BYTES + 15] = none[index * TS_PACKET_BYTES + 15]! ^ 1;
      }
      expect(() => inspect(none)).toThrow(expect.objectContaining({ code: "verification_container", probeError: "Missing MPEG-TS program map" }));
      expect(() => inspect(new Uint8Array([0x47, 0x40, 0x00, 0x10]))).toThrow(expect.objectContaining({ code: "verification_container" }));
    });
  });
});
