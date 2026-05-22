import type { VideoCodec, AudioCodec } from "../../types/codec";
import { parseVideoCodec, parseAudioCodec } from "../../classifier/codec-registry";

// mp4box references `window` at module load. We're imported from the
// MV3 service worker (via @savemedia/core's index re-exports) where
// `window` is undefined — a top-level import would crash the SW with
// `ReferenceError: window is not defined` before any handler runs.
// Lazy-loading defers the module evaluation to the only context that
// actually calls probeInitSegment (the offscreen engine document or a
// node test runner), neither of which lacks `window`/`globalThis`.

export interface InitProbeResult {
  readonly videoCodec: VideoCodec | null;
  readonly audioCodec: AudioCodec | null;
  readonly trackCount: number;
  readonly probeFailed: boolean;
}

interface MP4BoxInfo {
  tracks?: ReadonlyArray<unknown>;
  videoTracks?: ReadonlyArray<{ codec: string }>;
  audioTracks?: ReadonlyArray<{ codec: string }>;
}

export async function probeInitSegment(bytes: Uint8Array): Promise<InitProbeResult> {
  const { default: MP4Box } = await import("mp4box");
  return new Promise(resolve => {
    const mp4 = MP4Box.createFile();
    let resolved = false;

    mp4.onReady = (info: unknown) => {
      const i = info as MP4BoxInfo;
      if (resolved) return;
      resolved = true;
      const videoTrack = i.videoTracks?.[0];
      const audioTrack = i.audioTracks?.[0];
      resolve({
        videoCodec: videoTrack ? parseVideoCodec(videoTrack.codec) : null,
        audioCodec: audioTrack ? parseAudioCodec(audioTrack.codec) : null,
        trackCount: i.tracks?.length ?? 0,
        probeFailed: false,
      });
    };

    mp4.onError = () => {
      if (resolved) return;
      resolved = true;
      resolve({ videoCodec: null, audioCodec: null, trackCount: 0, probeFailed: true });
    };

    const slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const tagged = slice as ArrayBuffer & { fileStart: number };
    tagged.fileStart = 0;

    try {
      mp4.appendBuffer(tagged);
      mp4.flush();
    } catch {
      if (!resolved) {
        resolved = true;
        resolve({ videoCodec: null, audioCodec: null, trackCount: 0, probeFailed: true });
      }
    }

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ videoCodec: null, audioCodec: null, trackCount: 0, probeFailed: true });
      }
    }, 5000);
  });
}
