import { classify } from "@savemedia/core";
import type { AudioRenditionId, StreamDescriptor, Variant, VariantId } from "@savemedia/core";
import type { BridgeToBackgroundMessage } from "../types/messages";
import type { Logger } from "../util/logger";

export type CaptureMessage = Extract<BridgeToBackgroundMessage, { type: "capture" }>;

/** The slice of a fetch Response the capture probe actually reads. */
export interface CaptureFetchResponse {
  readonly headers: { forEach(cb: (value: string, key: string) => void): void };
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  clone(): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface CaptureDeps {
  readonly fetchFn: (
    url: string,
    init: { readonly credentials: "include"; readonly headers?: Readonly<Record<string, string>> },
  ) => Promise<CaptureFetchResponse>;
  /** Receives every descriptor that passed the surfacing gate. */
  readonly onDescriptor: (tabId: number, descriptor: StreamDescriptor) => void;
  readonly logger?: Logger;
}

export type CaptureHandler = (tabId: number, msg: CaptureMessage) => Promise<void>;

export function createCaptureHandler(deps: CaptureDeps): CaptureHandler {
  return async function handleCapture(tabId, msg) {
    const cap = msg.payload;
    if (!cap.url && cap.kind !== "eme") return;

    const headers: Record<string, string> = cap.responseHeaders ? { ...cap.responseHeaders } : {};
    let bodyBytes: Uint8Array | null = null;
    let manifestText: string | null = null;

    if (cap.url) {
      try {
        // A demuxed pair's video half is a full-length media file (hundreds
        // of MB on youtube); range-limit that probe so classification does
        // not pull the whole body into the service worker to sniff 4 KiB.
        const init = cap.audioUrl === undefined
          ? { credentials: "include" as const }
          : { credentials: "include" as const, headers: { range: "bytes=0-4095" } };
        const r = await deps.fetchFn(cap.url, init);
        r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const ct = headers["content-type"] ?? "";
        if (/(mpegurl|dash\+xml|xml|text)/i.test(ct) || /\.(m3u8|mpd)(\?|$)/i.test(cap.url)) {
          manifestText = await r.text();
        } else {
          bodyBytes = await probeBytes(r);
        }
      } catch (err) {
        deps.logger?.debug("capture fetch failed", { url: cap.url, err: String(err) });
      }
    }

    if (cap.kind === "eme" && cap.keySystem) {
      headers["x-savemedia-eme-keysystem"] = cap.keySystem;
    }

    const classified = await classify({
      tabId,
      pageUrl: cap.pageUrl,
      url: cap.url ?? cap.pageUrl,
      headers,
      bodyBytes,
      manifestText,
    });

    // A capture carrying a companion audio URL is a demuxed pair; reshape it
    // for the av-merge path once the video half is confirmed downloadable.
    // An unconfirmed half (expired signature, fetch failure) falls through
    // as-is and is dropped by the surfacing gate below.
    const descriptor = cap.audioUrl !== undefined && classified.capabilities.directDownload
      ? demuxedPairDescriptor(
        classified,
        cap.audioUrl,
        declaredTotalBytes(headers),
        await probeDeclaredBytes(deps, cap.audioUrl),
      )
      : classified;

    if (!shouldSurfaceDescriptor(descriptor)) return;
    deps.onDescriptor(tabId, descriptor);
  };
}

export function shouldSurfaceDescriptor(descriptor: StreamDescriptor): boolean {
  if (descriptor.drm) return true;
  if (descriptor.capabilities.directDownload) return true;
  return descriptor.protocol === "hls" || descriptor.protocol === "dash";
}

/**
 * First 4 KiB of the probe body, read incrementally with the stream cancelled
 * afterwards: a server that ignores the range header answers 200 with the
 * full body, and buffering it whole would pull a multi-GB media file into the
 * service worker just to sniff magic bytes. Falls back to the buffering path
 * when the response exposes no body stream (test doubles).
 */
async function probeBytes(r: CaptureFetchResponse): Promise<Uint8Array> {
  if (!r.body) {
    const buf = await r.clone().arrayBuffer();
    return new Uint8Array(buf.slice(0, 4096));
  }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
  const out = new Uint8Array(Math.min(total, 4096));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.byteLength - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.byteLength) break;
  }
  return out;
}

/**
 * Range-probe a companion track for its declared byte total so the browser
 * output-size guard counts both halves of a demuxed pair. Any failure yields
 * null — the size stays unknown rather than wrong.
 */
async function probeDeclaredBytes(deps: CaptureDeps, url: string): Promise<number | null> {
  try {
    const r = await deps.fetchFn(url, {
      credentials: "include",
      headers: { range: "bytes=0-0" },
    });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    try { await r.body?.cancel(); } catch { /* stream already closed */ }
    return declaredTotalBytes(headers);
  } catch {
    return null;
  }
}

/**
 * Byte total declared by the classification probe: the total of a 206's
 * `content-range` (the demuxed probe is range-limited), else plain
 * `content-length`. An unknown (`*`) or unparsable total yields null —
 * the size stays unknown rather than wrong.
 */
function declaredTotalBytes(headers: Readonly<Record<string, string>>): number | null {
  const contentRange = headers["content-range"];
  const raw = contentRange === undefined
    ? headers["content-length"]
    : /\/(\d+)\s*$/.exec(contentRange)?.[1];
  const total = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/**
 * Reshape a confirmed progressive video descriptor plus its companion audio
 * URL into the demuxed form dispatch understands: protocol "dash" with one
 * video variant and one linked audio rendition, each a single-URL
 * `dash-segments` ref (the documented progressive `MergeTrack` case — no
 * init segment, one media URL). Core dispatch's DASH branch turns exactly
 * this shape into an `AvMergePlan`; `directDownload` is cleared so the
 * video-only half can never ship alone as a silent "direct" download. The
 * `direct-url` source is kept so router de-duplication keys stay per-video.
 *
 * `videoSizeBytes` / `audioSizeBytes` (each probe's declared total) ride the
 * halves as `estimatedSize` so dispatch's browser-output size guard stays
 * reachable and counts the whole merged output — left null, a multi-GB pair
 * would be fetched whole and OOM the offscreen document. An unprobeable half
 * stays null rather than wrong.
 */
export function demuxedPairDescriptor(
  descriptor: StreamDescriptor,
  audioUrl: string,
  videoSizeBytes: number | null,
  audioSizeBytes: number | null,
): StreamDescriptor {
  if (descriptor.source.kind !== "direct-url") return descriptor;
  const videoUrl = descriptor.source.url;
  const renditionId = `${audioUrl}#audio` as AudioRenditionId;
  const video: Variant = {
    id: `${videoUrl}#video` as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: null,
    estimatedSize: videoSizeBytes,
    videoCodec: null,
    audioCodec: null,
    audioRenditionId: renditionId,
    segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [videoUrl] },
  };
  const audio: Variant = {
    id: `${audioUrl}#audio` as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: null,
    estimatedSize: audioSizeBytes,
    videoCodec: null,
    audioCodec: null,
    audioRenditionId: renditionId,
    segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [audioUrl] },
  };
  return {
    ...descriptor,
    protocol: "dash",
    variants: [video],
    audioRenditions: [audio],
    capabilities: {
      directDownload: false,
      remuxableTo: [],
      drmBlocked: descriptor.capabilities.drmBlocked,
    },
  };
}
