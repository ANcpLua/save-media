import type { Container } from "../types/stream";

const FTYP_BRAND_MAP: Record<string, Container> = {
  "isom": "mp4", "iso2": "mp4", "mp41": "mp4", "mp42": "mp4", "avc1": "mp4",
  "M4V ": "m4v", "M4A ": "mp4",
  "qt  ": "mov",
  "msdh": "fmp4", "msix": "fmp4", "dash": "fmp4", "cmfc": "cmaf", "cmf2": "cmaf",
};

export function detectContainerFromBytes(bytes: Uint8Array): Container {
  if (bytes.length < 4) return "unknown";

  // ISO BMFF: bytes 4..8 = "ftyp"
  if (bytes.length >= 12
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    return FTYP_BRAND_MAP[brand] ?? "mp4";
  }

  // EBML (Matroska / WebM): 1A 45 DF A3
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "mkv";
  }

  // MPEG-TS: 0x47 sync byte every 188 bytes
  if (bytes[0] === 0x47 && bytes.length > 188 && bytes[188] === 0x47) {
    return "mpegts";
  }

  // FLV: "FLV\x01"
  if (bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56 && bytes[3] === 0x01) {
    return "flv";
  }

  // AVI: RIFF ___ AVI<space>
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x41 && bytes[9] === 0x56 && bytes[10] === 0x49 && bytes[11] === 0x20) {
    return "avi";
  }

  // ASF/WMV: 30 26 B2 75 8E 66 CF 11
  if (bytes.length >= 16
    && bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75
    && bytes[4] === 0x8e && bytes[5] === 0x66 && bytes[6] === 0xcf && bytes[7] === 0x11) {
    return "wmv";
  }

  return "unknown";
}

const MIME_MAP: Record<string, Container> = {
  "video/mp4": "mp4",
  "video/x-m4v": "m4v",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "audio/webm": "webm",
  "video/x-matroska": "mkv",
  "video/mp2t": "mpegts",
  "video/avi": "avi",
  "video/x-msvideo": "avi",
  "video/x-ms-wmv": "wmv",
  "video/x-flv": "flv",
};

export function detectContainerFromMime(mime: string): Container {
  if (!mime) return "unknown";
  const cleaned = mime.split(";")[0]!.trim().toLowerCase();
  return MIME_MAP[cleaned] ?? "unknown";
}
