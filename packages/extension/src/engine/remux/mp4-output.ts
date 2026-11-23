import { Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk } from "mediabunny";
import { PositionedBlob } from "../blob-parts";

/** The muxer gathers its writes into pieces of this size before it hands them on. */
const MUX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * An MP4 the muxer writes straight into Blobs. The media goes out as it is
 * muxed and the index (moov) follows at the end, so neither the muxer nor
 * the engine document holds the file: the muxer keeps a few chunks, and
 * PositionedBlob folds what it is handed. An index at the front would make
 * the muxer keep every sample in memory until the last one is known.
 */
export function mp4BlobOutput(): { readonly output: Output; readonly finish: () => Blob } {
  const file = new PositionedBlob();
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) { file.write(chunk.data, chunk.position); },
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: MUX_CHUNK_BYTES }),
  });
  return { output, finish: () => file.toBlob("video/mp4") };
}
