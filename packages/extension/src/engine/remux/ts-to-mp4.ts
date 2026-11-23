import {
  Input,
  BlobSource,
  MPEG_TS,
  Conversion,
  type Source,
} from "mediabunny";
import { mp4BlobOutput } from "./mp4-output";

/**
 * Remux a concatenated MPEG-TS byte stream into an MP4 (ISO-BMFF) byte
 * stream. No re-encoding — the H.264 video + AAC audio packets are
 * copied verbatim into MP4 sample tables. Same bytes, different
 * container, playable in QuickTime / iOS / everywhere.
 *
 * Driven by mediabunny's Conversion API. The library handles all the
 * timestamp rebasing and box-writing; we just hand it a Source (the
 * TS stream as a Blob) and a Target (an MP4 written into Blobs, see
 * mp4BlobOutput) and call execute(). Neither side is held in the engine
 * document's memory. Metadata streams such as timed ID3 are not carried over.
 *
 * Throws if the input has no usable video track (e.g. corrupted TS
 * stream) or the output container can't accept the source's codec
 * (shouldn't happen for H.264 + AAC, which MP4 natively supports).
 *
 * `signal`: the user's cancel ends the conversion where it stands, and the
 * abort itself is what is thrown, so the job ends as cancelled.
 */
export async function remuxTsToMp4(
  ts: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  // The Blob is read in slices, so the stream is not copied into memory again.
  const input = new Input({
    formats: [MPEG_TS],
    source: new BlobSource(ts) as Source,
  });
  const { output, finish } = mp4BlobOutput();

  const conversion = await Conversion.init({ input, output });
  if (onProgress) conversion.onProgress = (fraction) => { if (!signal?.aborted) onProgress(fraction); };
  const stop = (): void => { void conversion.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    await conversion.execute();
  } catch (error) {
    // A cancelled conversion throws its own error: the cancel is the reason, and is what the job reports.
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }

  const mp4 = finish();
  if (!mp4.size) throw new Error("ts-to-mp4 remux produced no output");
  return mp4;
}
