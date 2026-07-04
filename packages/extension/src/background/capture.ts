import { classify } from "@savemedia/core";
import type { AudioRenditionId, StreamDescriptor, Variant, VariantId } from "@savemedia/core";
import type { BridgeToBackgroundMessage } from "../types/messages";
import type { Logger } from "../util/logger";

export type CaptureMessage = Extract<BridgeToBackgroundMessage, { type: "capture" }>;

/** The slice of a fetch Response the capture probe actually reads. */
export interface CaptureFetchResponse {
  readonly headers: { forEach(cb: (value: string, key: string) => void): void };
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
          const buf = await r.clone().arrayBuffer();
          bodyBytes = new Uint8Array(buf.slice(0, 4096));
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
      ? demuxedPairDescriptor(classified, cap.audioUrl, declaredTotalBytes(headers))
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
 * `videoSizeBytes` (the probe's declared total) rides the video half as
 * `estimatedSize` so dispatch's browser-output size guard stays reachable —
 * left null, a multi-GB pair would be fetched whole and OOM the offscreen
 * document. The audio half is never probed and stays null; the combined
 * estimate keys on the dominant video half.
 */
export function demuxedPairDescriptor(
  descriptor: StreamDescriptor,
  audioUrl: string,
  videoSizeBytes: number | null,
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
    estimatedSize: null,
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
