import { keySystemForUuid } from "../parser/dash/content-protection";

/**
 * Common Encryption (ISO/IEC 23001-7) declared inside ISO BMFF data: the
 * MP4, fMP4 and CMAF boxes a player reads before it can decode anything.
 */
export interface Mp4Protection {
  /** schm scheme type, such as cenc, cens, cbc1 or cbcs; null when no schm was read. */
  readonly scheme: string | null;
  /** The pssh system named when known, else its urn:uuid; null without a pssh. */
  readonly keySystem: string | null;
}

/** Protected sample entries (23001-7 encv/enca/enct/encs/encm/encf) and the older iTunes drms/drmi. */
const PROTECTED_SAMPLE_ENTRIES = new Set(["encv", "enca", "enct", "encs", "encm", "encf", "drms", "drmi"]);
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "sinf", "schi"]);
// PIFF 1.1 boxes that carry the same declarations as pssh, tenc and senc.
const PIFF_PROTECTION = new Set([
  "d08a4f1810f34a82b6c832d8aba183d3", "8974dbce7be74c5184f97148f9882554", "a2394f525a9b4f14a2446c427c648df4",
]);

interface Found { protected: boolean; scheme: string | null; keySystem: string | null }

/**
 * Walks the box tree of a whole file, an init segment, a media segment or
 * any prefix of them. A truncated tail is ignored: what was read decides.
 * Encryption is declared by a protected sample entry, a protection scheme
 * (sinf/schm/tenc), a protection system header (pssh) or sample encryption
 * data (senc); any one of them is enough.
 */
export function findMp4Protection(bytes: Uint8Array): Mp4Protection | null {
  const found: Found = { protected: false, scheme: null, keySystem: null };
  walk(bytes, 0, bytes.length, found, 0);
  return found.protected ? { scheme: found.scheme, keySystem: found.keySystem } : null;
}

function walk(bytes: Uint8Array, start: number, end: number, found: Found, depth: number): void {
  if (depth > 12) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset + 8 <= end;) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header) return;
    const type = fourCc(bytes, offset + 4);
    const boxEnd = Math.min(end, offset + size);
    inspect(bytes, type, offset + header, boxEnd, found, depth);
    offset += size;
  }
}

function inspect(bytes: Uint8Array, type: string, body: number, end: number, found: Found, depth: number): void {
  if (CONTAINERS.has(type)) {
    if (type === "sinf") found.protected = true;
    walk(bytes, body, end, found, depth + 1);
  } else if (type === "stsd") {
    sampleEntries(bytes, body + 8, end, found, depth);
  } else if (type === "pssh") {
    found.protected = true;
    // Full box header, then the 16-byte SystemID.
    if (body + 20 <= end) found.keySystem ??= keySystemForUuid(uuid(bytes, body + 4));
  } else if (type === "schm") {
    found.protected = true;
    if (body + 8 <= end) found.scheme ??= fourCc(bytes, body + 4).trim();
  } else if (type === "tenc" || type === "senc") {
    found.protected = true;
  } else if (type === "uuid" && body + 16 <= end && PIFF_PROTECTION.has(uuid(bytes, body).replace(/-/g, ""))) {
    found.protected = true;
  }
}

/** Sample entries have format-specific fields before their child boxes, so locate sinf by its header. */
function sampleEntries(bytes: Uint8Array, start: number, end: number, found: Found, depth: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset + 8 <= end;) {
    const size = view.getUint32(offset);
    if (size < 8) return;
    const entryEnd = Math.min(end, offset + size);
    if (PROTECTED_SAMPLE_ENTRIES.has(fourCc(bytes, offset + 4))) found.protected = true;
    for (let at = offset + 16; at + 8 <= entryEnd; at++) {
      if (bytes[at + 4] !== 0x73 || fourCc(bytes, at + 4) !== "sinf") continue;
      const childSize = view.getUint32(at);
      if (childSize >= 8 && at + childSize <= entryEnd) {
        inspect(bytes, "sinf", at + 8, at + childSize, found, depth + 1);
        break;
      }
    }
    offset += size;
  }
}

function fourCc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

function uuid(bytes: Uint8Array, at: number): string {
  const hex = Array.from(bytes.subarray(at, at + 16), b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
