/** Rewrites MPEG-TS program maps in fixtures, with a valid CRC, for tests. */
export const TS_PACKET = 188;

export function pid(bytes: Uint8Array): number { return ((bytes[1]! & 31) << 8) | bytes[2]!; }

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}

/** Rewrites every PMT on `pmtPid`; `edit` receives the section without its CRC and returns the new one. */
export function withProgramMap(ts: Uint8Array, edit: (section: number[]) => number[], pmtPid = 0x1000): Uint8Array {
  const out = ts.slice();
  for (let offset = 0; offset < out.length; offset += TS_PACKET) {
    const packet = out.subarray(offset, offset + TS_PACKET);
    if (pid(packet) !== pmtPid || !(packet[1]! & 0x40)) continue;
    const length = 3 + (((packet[6]! & 15) << 8) | packet[7]!);
    const body = edit([...packet.subarray(5, 5 + length - 4)]);
    const size = body.length + 4 - 3;
    body[1] = (body[1]! & 0xf0) | (size >> 8);
    body[2] = size & 0xff;
    const crc = crc32(Uint8Array.from(body));
    packet.fill(0xff, 5);
    packet.set([...body, crc >>> 24, (crc >> 16) & 255, (crc >> 8) & 255, crc & 255], 5);
  }
  return out;
}

export const addCaDescriptor = (section: number[]): number[] => {
  // program_info: CA_system_ID 0x0b00, CA_PID 0x1ff (ISO/IEC 13818-1 2.6.16).
  const infoLength = ((section[10]! & 15) << 8) | section[11]!;
  const descriptor = [0x09, 0x04, 0x0b, 0x00, 0xe1, 0xff];
  const next = [...section.slice(0, 12), ...descriptor, ...section.slice(12)];
  next[10] = 0xf0 | ((infoLength + descriptor.length) >> 8);
  next[11] = (infoLength + descriptor.length) & 0xff;
  return next;
};

export const replaceStreamType = (from: number, to: number) => (section: number[]): number[] => {
  const next = section.slice();
  for (let pos = 12 + (((next[10]! & 15) << 8) | next[11]!); pos + 5 <= next.length; pos += 5 + (((next[pos + 3]! & 15) << 8) | next[pos + 4]!)) {
    if (next[pos] === from) next[pos] = to;
  }
  return next;
};
