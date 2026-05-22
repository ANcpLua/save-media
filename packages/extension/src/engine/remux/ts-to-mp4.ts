import {
  Input,
  BlobSource,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  MPEG_TS,
  Conversion,
  type Source,
} from "mediabunny";

/**
 * Remux a concatenated MPEG-TS byte stream into an MP4 (ISO-BMFF) byte
 * stream. No re-encoding — the H.264 video + AAC audio packets are
 * copied verbatim into MP4 sample tables. Same bytes, different
 * container, playable in QuickTime / iOS / everywhere.
 *
 * Driven by mediabunny's Conversion API. The library handles all the
 * timestamp rebasing and box-writing; we just hand it a Source (the
 * TS bytes wrapped in a Blob) and a Target (an in-memory ArrayBuffer)
 * and call execute().
 *
 * Throws if the input has no usable video track (e.g. corrupted TS
 * stream) or the output container can't accept the source's codec
 * (shouldn't happen for H.264 + AAC, which MP4 natively supports).
 */
export async function remuxTsToMp4(
  tsBytes: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const blob = new Blob([tsBytes as BlobPart], { type: "video/MP2T" });
  const input = new Input({
    formats: [MPEG_TS],
    source: new BlobSource(blob) as Source,
  });
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  });

  const conversion = await Conversion.init({ input, output });
  if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction);
  await conversion.execute();

  if (!target.buffer) {
    throw new Error("ts-to-mp4 remux produced no output");
  }
  return new Uint8Array(target.buffer);
}
