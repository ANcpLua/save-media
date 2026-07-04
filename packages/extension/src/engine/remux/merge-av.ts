import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  type EncodedPacket,
} from "mediabunny";

/**
 * Merge a demuxed video-only stream and a demuxed audio-only stream into one
 * MP4, copying the already-encoded packets with NO re-encode. This is how
 * adaptive sources that ship video and audio separately become a single
 * playable file: Twitter/X HLS audio groups, Instagram DASH, and YouTube
 * adaptive itags all hand us two byte streams that must be interleaved into
 * one container.
 *
 * Container/codec contract: MP4 natively holds H.264/H.265/AV1 video + AAC
 * audio. The caller is responsible for selecting compatible tracks (e.g. a
 * YouTube H.264 video itag + an AAC audio itag). VP9/Opus need a WebM output
 * and are out of scope for this function.
 */
export async function mergeAvToMp4(
  videoBytes: Uint8Array,
  audioBytes: Uint8Array,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const videoInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(videoBytes) });
  const audioInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(audioBytes) });

  const videoTrack = await videoInput.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("merge-av: the video stream has no video track");
  const audioTrack = await audioInput.getPrimaryAudioTrack();
  if (!audioTrack) throw new Error("merge-av: the audio stream has no audio track");

  const videoCodec = videoTrack.codec;
  if (!videoCodec) throw new Error("merge-av: unrecognised video codec");
  const audioCodec = audioTrack.codec;
  if (!audioCodec) throw new Error("merge-av: unrecognised audio codec");

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const videoSource = new EncodedVideoPacketSource(videoCodec);
  const audioSource = new EncodedAudioPacketSource(audioCodec);
  output.addVideoTrack(videoSource);
  output.addAudioTrack(audioSource);
  await output.start();

  const videoConfig = await videoTrack.getDecoderConfig();
  const audioConfig = await audioTrack.getDecoderConfig();
  const videoMeta = videoConfig ? { decoderConfig: videoConfig } : undefined;
  const audioMeta = audioConfig ? { decoderConfig: audioConfig } : undefined;

  // Demuxed tracks can start at a NEGATIVE presentation timestamp — AAC in
  // particular carries encoder-priming, so its first packet is often slightly
  // before zero — and the MP4 muxer rejects negatives. Shift BOTH tracks by a
  // single global offset so the earliest packet lands at 0 while the relative
  // audio/video sync is preserved.
  const videoFirst = await videoTrack.getFirstTimestamp();
  const audioFirst = await audioTrack.getFirstTimestamp();
  const shift = Math.max(0, -Math.min(videoFirst, audioFirst));
  const rebase = (packet: EncodedPacket): EncodedPacket =>
    shift > 0 ? packet.clone({ timestamp: packet.timestamp + shift }) : packet;

  onProgress?.(0);

  let first = true;
  for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
    await videoSource.add(rebase(packet), first ? videoMeta : undefined);
    first = false;
  }
  onProgress?.(0.5);

  first = true;
  for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
    await audioSource.add(rebase(packet), first ? audioMeta : undefined);
    first = false;
  }

  await output.finalize();
  if (!target.buffer) throw new Error("merge-av: the muxer produced no output");
  onProgress?.(1);
  return new Uint8Array(target.buffer);
}
