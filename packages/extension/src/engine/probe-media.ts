/**
 * What a video is, read without saving it: duration and frame size from a
 * metadata load in a <video> element, plus a 64-bit difference hash of the
 * frame at 40 % when its pixels are readable (always for the engine's blob
 * output, for a remote file only when its server allows CORS). Needs a DOM,
 * so it runs in the offscreen document on Chromium and in the background
 * page on Firefox.
 */
export interface MediaInfo {
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly frameHash: string | null;
}

export const PROBE_MEDIA = "probe-media";

export interface ProbeMediaRequest {
  readonly type: typeof PROBE_MEDIA;
  readonly url: string;
}

export function isProbeMediaRequest(msg: unknown): msg is ProbeMediaRequest {
  return typeof msg === "object" && msg !== null
    && (msg as { type?: unknown }).type === PROBE_MEDIA
    && typeof (msg as { url?: unknown }).url === "string";
}

export function isMediaInfo(value: unknown): value is MediaInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.durationSec === "number" && typeof v.width === "number" && typeof v.height === "number"
    && (v.frameHash === null || typeof v.frameHash === "string");
}

const PROBE_TIMEOUT_MS = 15_000;

export async function probeMedia(url: string): Promise<MediaInfo | null> {
  // A CORS load gives pixels for the frame hash; a server without CORS
  // headers fails it, and a plain load still gives duration and size.
  return (await load(url, true)) ?? (await load(url, false));
}

function load(url: string, readPixels: boolean): Promise<MediaInfo | null> {
  return new Promise(resolve => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    if (readPixels) video.crossOrigin = "anonymous";
    let settled = false;
    const finish = (info: MediaInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(info);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const { duration, videoWidth: width, videoHeight: height } = video;
      if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
        finish(null);
        return;
      }
      if (!readPixels) {
        finish({ durationSec: duration, width, height, frameHash: null });
        return;
      }
      video.onseeked = () => finish({ durationSec: duration, width, height, frameHash: differenceHash(video) });
      video.currentTime = duration * 0.4;
    };
    video.src = url;
  });
}

/** 9x8 grayscale, one bit per horizontal neighbour pair: survives rescaling and re-encoding. */
function differenceHash(video: HTMLVideoElement): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 9;
  canvas.height = 8;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, 9, 8);
    const px = ctx.getImageData(0, 0, 9, 8).data;
    const luma = (i: number) => px[i * 4]! * 0.299 + px[i * 4 + 1]! * 0.587 + px[i * 4 + 2]! * 0.114;
    let bits = "";
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) bits += luma(y * 9 + x) > luma(y * 9 + x + 1) ? "1" : "0";
    }
    return bits;
  } catch {
    return null; // tainted canvas
  }
}
