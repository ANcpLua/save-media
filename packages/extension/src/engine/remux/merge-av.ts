import {
  ALL_FORMATS,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  type EncodedPacket,
  type Source,
} from "mediabunny";
import { mp4BlobOutput } from "./mp4-output";

/**
 * Put a demuxed video stream, and the audio stream that belongs to it when
 * there is one, into one MP4, copying the already-encoded packets with NO
 * re-encode. This is how adaptive sources that ship video and audio
 * separately become a single playable file: an HLS audio group or a DASH
 * manifest hands us two byte streams that must be interleaved into one
 * container. A stream the manifest gives no separate audio for is copied as
 * it is: with the sound its own bytes carry (one DASH representation can hold
 * video and audio together), or with its picture alone when they carry none.
 * The bytes decide that, never the manifest's codecs attribute.
 *
 * Both sides are Blobs: the inputs are read in slices and the output is
 * written into Blobs (mp4BlobOutput), so the streams are never held in the
 * engine document's memory.
 *
 * `audioStartSeconds` is for an audio stream of bare frames (HLS packed
 * audio), which carries no clock of its own: the time its first sample plays
 * on the video's clock, as the stream's own tag states it. Its packets are
 * placed from there, so sound and picture stay together.
 *
 * Container/codec contract: the MP4 muxer takes H.264, H.265, AV1, VP9 and
 * VP8 video and AAC, MP3, Opus, FLAC, Vorbis, AC-3 and E-AC-3 audio, whatever
 * container (MP4, WebM, MPEG-TS) each input arrives in. Dispatch lets only
 * those families through.
 *
 * `signal`: the user's cancel is looked at before every packet, so the merge
 * stops within one packet and the abort itself is what is thrown.
 */
export async function mergeAvToMp4(
  video: Blob,
  audio: Blob | null,
  onProgress?: (fraction: number) => void,
  audioStartSeconds: number | null = null,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  const videoInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(video) as Source });
  const audioInput = audio ? new Input({ formats: ALL_FORMATS, source: new BlobSource(audio) as Source }) : null;

  const videoTrack = await videoInput.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("merge-av: the video stream has no video track");
  // Without a separate audio stream, the video stream's own audio track is the sound of the file.
  const audioTrack = await (audioInput ?? videoInput).getPrimaryAudioTrack();
  if (audioInput && !audioTrack) throw new Error("merge-av: the audio stream has no audio track");

  const videoCodec = videoTrack.codec;
  if (!videoCodec) throw new Error("merge-av: unrecognised video codec");
  const audioCodec = audioTrack?.codec ?? null;
  if (audioTrack && !audioCodec) throw new Error("merge-av: unrecognised audio codec");

  const { output, finish } = mp4BlobOutput();
  const videoSource = new EncodedVideoPacketSource(videoCodec);
  const audioSource = audioCodec ? new EncodedAudioPacketSource(audioCodec) : null;
  output.addVideoTrack(videoSource);
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const videoConfig = await videoTrack.getDecoderConfig();
  const audioConfig = audioTrack ? await audioTrack.getDecoderConfig() : null;

  // Demuxed tracks can start at a NEGATIVE presentation timestamp — AAC in
  // particular carries encoder-priming, so its first packet is often slightly
  // before zero — and the MP4 muxer rejects negatives. Shift BOTH tracks by a
  // single global offset so the earliest packet lands at 0 while the relative
  // audio/video sync is preserved.
  const videoFirst = await videoTrack.getFirstTimestamp();
  const audioOwnFirst = audioTrack ? await audioTrack.getFirstTimestamp() : videoFirst;
  // Bare audio frames count from their own first sample: move them to the time their tag states.
  const audioMove = audioInput && audioStartSeconds !== null ? audioStartSeconds - audioOwnFirst : 0;
  const audioFirst = audioOwnFirst + audioMove;
  const shift = Math.max(0, -Math.min(videoFirst, audioFirst));
  const rebase = (packet: EncodedPacket, move = 0): EncodedPacket =>
    shift + move !== 0 ? packet.clone({ timestamp: packet.timestamp + shift + move }) : packet;

  // The inputs are almost all packet data, so the bytes copied say how far the merge is.
  const inputBytes = video.size + (audio?.size ?? 0);
  let copied = 0;
  let fraction = 0;
  const progress = (bytes: number): void => {
    copied += bytes;
    const next = inputBytes > 0 ? Math.min(0.99, copied / inputBytes) : 0;
    // A report per packet would flood the popup: one per percent is enough.
    if (next - fraction < 0.01) return;
    fraction = next;
    onProgress?.(fraction);
  };
  onProgress?.(0);

  // Packets go in by time, the two tracks in turn, so the file is interleaved
  // and the muxer never waits on one track while it holds the other.
  const videoPackets = new EncodedPacketSink(videoTrack).packets()[Symbol.asyncIterator]();
  const audioPackets = audioTrack ? new EncodedPacketSink(audioTrack).packets()[Symbol.asyncIterator]() : null;
  try {
    let nextVideo = await videoPackets.next();
    let nextAudio = audioPackets ? await audioPackets.next() : null;
    let firstVideo = true;
    let firstAudio = true;
    while (!nextVideo.done || (nextAudio && !nextAudio.done)) {
      signal?.throwIfAborted();
      const audioTurn = !!nextAudio && !nextAudio.done && (nextVideo.done || nextAudio.value.timestamp + audioMove < nextVideo.value.timestamp);
      if (audioTurn) {
        const packet = rebase(nextAudio!.value as EncodedPacket, audioMove);
        await audioSource!.add(packet, firstAudio && audioConfig ? { decoderConfig: audioConfig } : undefined);
        firstAudio = false;
        progress(packet.data.byteLength);
        nextAudio = await audioPackets!.next();
      } else {
        const packet = rebase(nextVideo.value as EncodedPacket);
        await videoSource.add(packet, firstVideo && videoConfig ? { decoderConfig: videoConfig } : undefined);
        firstVideo = false;
        progress(packet.data.byteLength);
        nextVideo = await videoPackets.next();
      }
    }
    await output.finalize();
  } catch (error) {
    await videoPackets.return?.(undefined).catch(() => undefined);
    await audioPackets?.return?.(undefined).catch(() => undefined);
    await output.cancel().catch(() => undefined);
    throw error;
  }

  const merged = finish();
  if (!merged.size) throw new Error("merge-av: the muxer produced no output");
  onProgress?.(1);
  return merged;
}
