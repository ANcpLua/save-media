/** Minimal ISO BMFF builders for clear and Common Encryption init segments in tests. */
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));

export function box(type: string, ...children: (Uint8Array | number[])[]): Uint8Array {
  const payload = children.map(child => Uint8Array.from(child));
  const size = 8 + payload.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(ascii(type), 4);
  let offset = 8;
  for (const part of payload) { out.set(part, offset); offset += part.length; }
  return out;
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const fullBox = (type: string, ...children: (Uint8Array | number[])[]) => box(type, [0, 0, 0, 0], ...children);

export const WIDEVINE_SYSTEM_ID = [0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed];

/**
 * An init segment (ftyp + moov) with one video track. `scheme` makes it a
 * Common Encryption track (encv + sinf/schm/tenc); `pssh` adds a Widevine
 * protection system header.
 */
export function initSegment(options: { scheme?: "cenc" | "cbcs"; pssh?: boolean } = {}): Uint8Array {
  const avcC = box("avcC", [1, 66, 0, 30]);
  const entry = options.scheme
    ? box("encv", new Array(78).fill(0), avcC, box("sinf", box("frma", ascii("avc1")),
      fullBox("schm", ascii(options.scheme), [0, 1, 0, 0]), box("schi", fullBox("tenc", [0, 0, 1, 8], new Array(16).fill(7)))))
    : box("avc1", new Array(78).fill(0), avcC);
  const stsd = fullBox("stsd", [0, 0, 0, 1], entry);
  const trak = box("trak", box("tkhd", new Array(84).fill(0)),
    box("mdia", box("mdhd", new Array(24).fill(0)), box("minf", box("stbl", stsd))));
  const pssh = options.pssh ? [box("pssh", [0, 0, 0, 0], WIDEVINE_SYSTEM_ID, [0, 0, 0, 0])] : [];
  return concat(box("ftyp", ascii("iso6"), [0, 0, 0, 0], ascii("iso6dash")), box("moov", box("mvhd", new Array(100).fill(0)), ...pssh, trak));
}

export const fragment = (payload = [1, 2, 3]) => concat(box("moof"), box("mdat", payload));
