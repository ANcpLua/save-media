import { detectContainerFromBytes, findMp4Protection, hasMatroskaEncryption, readEbmlHeader, MATROSKA_CLUSTER, MATROSKA_SEGMENT,
  MATROSKA_TRACKS, type JobError, type OutputContainer } from "@savemedia/core";
import { TransportStreamInspector, TS_PACKET_BYTES } from "./mpeg-ts";

export const DIRECT_MEDIA_TYPES: Readonly<Record<OutputContainer, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mpegts: "video/mp2t",
};

/** What the first bytes of a response are, from magic bytes first and the declared type second. */
export type ResponseIdentity =
  | { readonly kind: "media"; readonly container: OutputContainer }
  | { readonly kind: "document"; readonly response: "page" | "data" }
  | { readonly kind: "unknown" };

export function identifyResponse(bytes: Uint8Array, headers: Readonly<Record<string, string>>): ResponseIdentity {
  const container = detectContainerFromBytes(bytes);
  if (container === "mp4" || container === "mov" || container === "webm" || container === "mkv" || container === "mpegts") {
    return { kind: "media", container };
  }
  // A fragmented MP4 under a DASH or CMAF brand is one playable MP4 file when
  // media follows its movie box. An init section alone is no video file.
  if ((container === "fmp4" || container === "cmaf") && mediaFollowsMovie(bytes, declaredTotal(headers))) {
    return { kind: "media", container: "mp4" };
  }
  // No media container starts with "<", "{" or "[": those bytes are a document whatever the declared type.
  const mime = headers["content-type"] ?? "";
  const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (/(?:html|xhtml|xml)/i.test(mime) || prefix.startsWith("<")) return { kind: "document", response: "page" };
  if (/(?:json|^text\/)/i.test(mime) || prefix.startsWith("{") || prefix.startsWith("[")) return { kind: "document", response: "data" };
  return { kind: "unknown" };
}

/** The file's whole length, from a Content-Range total or a Content-Length. */
function declaredTotal(headers: Readonly<Record<string, string>>): number | null {
  const range = /^bytes \d+-\d+\/(\d+)$/i.exec(headers["content-range"]?.trim() ?? "");
  const value = range?.[1] ?? headers["content-length"]?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * Walks the top-level boxes the bytes hold: a movie box followed by a movie
 * fragment or media data, in the bytes or, past them, by the file's length.
 */
function mediaFollowsMovie(bytes: Uint8Array, total: number | null): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let movie = false;
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    if (type === "moof" || type === "mdat") return movie;
    let size = view.getUint32(offset);
    if (size === 1 && offset + 16 <= bytes.length) size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
    if (size < 8) return false;
    if (type === "moov") movie = true;
    offset += size;
  }
  return movie && total !== null && total > offset;
}

export function requireDirectVideo(bytes: Uint8Array, headers: Readonly<Record<string, string>>): OutputContainer {
  const identity = identifyResponse(bytes, headers);
  if (identity.kind === "media") return identity.container;
  const response = identity.kind === "document" ? identity.response : "unsupported";
  throw { code: "unexpected_media_response", severity: "terminal", response } satisfies JobError;
}

function protectedMedia(detectedVia: "mp4-protection" | "matroska-protection", keySystem: string | null): never {
  throw { code: "encrypted_media_detected", severity: "terminal", detectedVia: [detectedVia], keySystem } satisfies JobError;
}

/** Common Encryption declared in MP4 or fMP4 boxes (a file, an init segment, or one of its boxes) refuses them. */
export function refuseProtectedMp4(bytes: Uint8Array): void {
  const found = findMp4Protection(bytes);
  if (found) protectedMedia("mp4-protection", found.keySystem ?? found.scheme);
}

/**
 * Encryption declared at the start of a track or file refuses it before it
 * is saved: Common Encryption in MP4 boxes, or ContentEncryption in a WebM or
 * Matroska track. Transport streams state scrambling per packet instead
 * (TransportStreamInspector).
 */
export function refuseProtectedMedia(bytes: Uint8Array): void {
  const container = detectContainerFromBytes(bytes);
  if (container === "mpegts") return;
  if (container === "webm" || container === "mkv") {
    if (hasMatroskaEncryption(bytes)) protectedMedia("matroska-protection", null);
    return;
  }
  refuseProtectedMp4(bytes);
}

/** The longest Tracks element read to find a track's encryption. */
const MAX_TRACKS_BYTES = 16 * 1024 * 1024;

/** Walks a WebM or Matroska file to its Tracks element, before the first cluster, and refuses encrypted tracks. */
async function refuseProtectedMatroska(blob: Blob, signal: AbortSignal): Promise<void> {
  let offset = 0;
  let end = blob.size;
  while (offset < end) {
    signal.throwIfAborted();
    const element = readEbmlHeader(new Uint8Array(await blob.slice(offset, offset + 12).arrayBuffer()), 0);
    if (!element || element.id === MATROSKA_CLUSTER) return;
    const body = offset + element.headerSize;
    if (element.id === MATROSKA_SEGMENT) {
      if (element.size !== null) end = Math.min(end, body + element.size);
      offset = body;
      continue;
    }
    if (element.id === MATROSKA_TRACKS) {
      const size = Math.min(element.size ?? end - body, MAX_TRACKS_BYTES);
      if (hasMatroskaEncryption(new Uint8Array(await blob.slice(offset, body + size).arrayBuffer()))) {
        protectedMedia("matroska-protection", null);
      }
      return;
    }
    if (element.size === null) return;
    offset = body + element.size;
  }
}

/**
 * The top-level boxes of an MP4 file, read a header at a time. Returns what
 * is wrong with the box structure, or null when every box was visited.
 */
async function visitBoxes(blob: Blob, signal: AbortSignal,
  visit: (type: string, offset: number, size: number, headerSize: number) => Promise<void>): Promise<string | null> {
  const decoder = new TextDecoder();
  for (let offset = 0; offset < blob.size;) {
    signal.throwIfAborted();
    const header = await blob.slice(offset, offset + 16).arrayBuffer();
    if (header.byteLength < 8) return "Truncated video box header";
    const view = new DataView(header);
    let size = view.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.byteLength < 16) return "Truncated extended video box header";
      size = Number(view.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) size = blob.size - offset;
    if (!Number.isSafeInteger(size) || size < headerSize || size > blob.size - offset) return "Invalid video box length";
    await visit(decoder.decode(new Uint8Array(header, 4, 4)), offset, size, headerSize);
    offset += size;
  }
  return null;
}

/** The movie box declares any Common Encryption; a pssh or PIFF box can also sit at the top level. */
async function refuseProtectedBox(blob: Blob, type: string, offset: number, size: number): Promise<void> {
  if (type === "moov" || type === "pssh" || type === "uuid") {
    refuseProtectedMp4(new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer()));
  }
}

/** Every packet of a transport stream held as a Blob, read a block at a time. The caller finishes the inspection. */
export async function inspectTransportFile(blob: Blob, signal: AbortSignal): Promise<TransportStreamInspector> {
  const transport = new TransportStreamInspector();
  const block = TS_PACKET_BYTES * 4096;
  for (let start = 0; start < blob.size; start += block) {
    signal.throwIfAborted();
    transport.inspect(new Uint8Array(await blob.slice(start, start + block).arrayBuffer()));
  }
  return transport;
}

/**
 * refuseProtectedMedia for a whole file held as a Blob, such as a track that
 * is one file. Only the boxes or elements that declare encryption are read
 * into memory, wherever in the file they lie. Bytes that are no such
 * container declare nothing and pass.
 */
export async function refuseProtectedFile(blob: Blob, signal: AbortSignal): Promise<void> {
  const container = detectContainerFromBytes(new Uint8Array(await blob.slice(0, 4096).arrayBuffer()));
  if (container === "mpegts") return;
  if (container === "webm" || container === "mkv") {
    await refuseProtectedMatroska(blob, signal);
    return;
  }
  await visitBoxes(blob, signal, (type, offset, size) => refuseProtectedBox(blob, type, offset, size));
}

// Structural checks adapted from video-rescue/internal/rescue/validate.go.
// MIT, ANcpLua; see licenses/video-rescue-MIT.txt. These are container checks,
// not Video Rescue's native full-stream FFmpeg decoding validation.
export async function validateDirectBlob(blob: Blob, container: OutputContainer, signal: AbortSignal): Promise<void> {
  const fail = (detail: string): never => {
    throw { code: "verification_container", severity: "terminal", probeError: detail };
  };
  signal.throwIfAborted();
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const identity = identifyResponse(head, { "content-length": String(blob.size) });
  if (identity.kind !== "media" || identity.container !== container) fail("The file container changed or its header is missing");
  if (container === "webm" || container === "mkv") {
    await refuseProtectedMatroska(blob, signal);
    return;
  }
  if (container === "mpegts") {
    (await inspectTransportFile(blob, signal)).finish();
    return;
  }
  let hasType = false;
  let hasMovie = false;
  let hasMedia = false;
  const broken = await visitBoxes(blob, signal, async (type, offset, size, headerSize) => {
    if (type === "ftyp") hasType = true;
    if (type === "moov" && size > headerSize) hasMovie = true;
    if (type === "mdat" && size > headerSize) hasMedia = true;
    await refuseProtectedBox(blob, type, offset, size);
  });
  if (broken) fail(broken);
  if ((!hasType && container !== "mov") || !hasMovie || !hasMedia) {
    fail("Required file-type, movie or media box is missing");
  }
}
