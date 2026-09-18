// Structural checks adapted from video-rescue/internal/rescue/validate.go.
// MIT, ANcpLua; see licenses/video-rescue-MIT.txt. These are container checks,
// not Video Rescue's native full-stream FFmpeg decoding validation.
export async function validateDirectBlob(blob: Blob, signal: AbortSignal): Promise<void> {
  const fail = (detail: string): never => {
    throw { code: "verification_container", severity: "terminal", probeError: detail };
  };
  signal.throwIfAborted();
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return;
  if (head.length < 8) fail("Unsupported or missing video container header");
  let hasType = false;
  let hasMovie = false;
  let hasMedia = false;
  for (let offset = 0; offset < blob.size;) {
    signal.throwIfAborted();
    const header = await blob.slice(offset, offset + 16).arrayBuffer();
    if (header.byteLength < 8) fail("Truncated MP4 box header");
    const view = new DataView(header);
    let size = view.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.byteLength < 16) fail("Truncated extended MP4 box header");
      size = Number(view.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) size = blob.size - offset;
    if (!Number.isSafeInteger(size) || size < headerSize || size > blob.size - offset) fail("Invalid MP4 box length");
    const type = new TextDecoder().decode(new Uint8Array(header, 4, 4));
    if (type === "ftyp") hasType = true;
    if (type === "moov") hasMovie = true;
    if (type === "mdat") hasMedia = true;
    offset += size;
  }
  if (!hasType || !hasMovie || !hasMedia) fail("Required MP4 file-type, movie or media box is missing");
}
