import type { FileRange, JobError } from "@savemedia/core";

/**
 * Top-level boxes of a fragmented MP4 that carry no samples: the segment index and its sub-index, free
 * space, a segment's type box, a producer's clock, and event messages (ISO/IEC 14496-12, 23009-1).
 */
const NO_SAMPLES = new Set(["sidx", "ssix", "free", "skip", "styp", "prft", "emsg"]);

/**
 * A playlist that addresses one fragmented MP4 by byte ranges may leave stretches of the file out. The file
 * as a whole is the stream only when those stretches hold nothing to play: whole boxes that carry no samples,
 * as a packager's index between the header and the first part. A stretch that holds a fragment or media
 * data, or that cuts a box, is media the playlist does not name: the file is then not the stream, and it is
 * refused as byte ranges that do not add up to one file. Only box headers are read, never a box's content.
 */
export async function refuseMediaInGaps(file: Blob, gaps: readonly FileRange[], manifestUrl: string, signal: AbortSignal): Promise<void> {
  const refuse = (): never => {
    throw { code: "hls_layout_unsupported", severity: "terminal", manifestUrl, layout: "byte-ranges" } satisfies JobError;
  };
  for (const gap of gaps) {
    const end = gap.offset + gap.length;
    let offset = gap.offset;
    while (offset < end) {
      signal.throwIfAborted();
      if (offset + 8 > end) refuse();
      const head = new Uint8Array(await file.slice(offset, Math.min(offset + 16, end)).arrayBuffer());
      if (head.length < 8) refuse();
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      let size = view.getUint32(0);
      if (size === 1) {
        if (head.length < 16) refuse();
        size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
      }
      const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
      // A size of 0 means "to the end of the file", which a box between two parts never is.
      if (size < 8 || !Number.isSafeInteger(size) || offset + size > end || !NO_SAMPLES.has(type)) refuse();
      offset += size;
    }
  }
}
