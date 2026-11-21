import { detectContainerFromBytes, type JobError, type OutputContainer } from "@savemedia/core";

export const DIRECT_MEDIA_TYPES: Readonly<Record<OutputContainer, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

export function requireDirectVideo(bytes: Uint8Array, headers: Readonly<Record<string, string>>): OutputContainer {
  const container = detectContainerFromBytes(bytes);
  if (container === "mp4" || container === "mov" || container === "webm" || container === "mkv") return container;

  const mime = headers["content-type"] ?? "";
  const prefix = new TextDecoder().decode(bytes).trimStart();
  const response = /(?:html|xhtml|xml)/i.test(mime) || prefix.startsWith("<") ? "page"
    : /(?:json|^text\/)/i.test(mime) || prefix.startsWith("{") || prefix.startsWith("[") ? "data" : "unsupported";
  throw { code: "unexpected_media_response", severity: "terminal", response } satisfies JobError;
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
  if (detectContainerFromBytes(head) !== container) fail("The file container changed or its header is missing");
  if (container === "webm" || container === "mkv") return;
  const decoder = new TextDecoder();
  let hasType = false;
  let hasMovie = false;
  let hasMedia = false;
  for (let offset = 0; offset < blob.size;) {
    signal.throwIfAborted();
    const header = await blob.slice(offset, offset + 16).arrayBuffer();
    if (header.byteLength < 8) fail("Truncated video box header");
    const view = new DataView(header);
    let size = view.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.byteLength < 16) fail("Truncated extended video box header");
      size = Number(view.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) size = blob.size - offset;
    if (!Number.isSafeInteger(size) || size < headerSize || size > blob.size - offset) fail("Invalid video box length");
    const type = decoder.decode(new Uint8Array(header, 4, 4));
    if (type === "ftyp") hasType = true;
    if (type === "moov" && size > headerSize) hasMovie = true;
    if (type === "mdat" && size > headerSize) hasMedia = true;
    offset += size;
  }
  if ((!hasType && container !== "mov") || !hasMovie || !hasMedia) {
    fail("Required file-type, movie or media box is missing");
  }
}
