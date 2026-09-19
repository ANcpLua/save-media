import { classify } from "@savemedia/core";
import type { AudioRenditionId, StreamDescriptor, Variant, VariantId } from "@savemedia/core";
import type { BridgeToBackgroundMessage, DiscoveryFailure } from "../types/messages";
import type { Logger } from "../util/logger";
import { checkResponseStatus, probeMedia, recoverRequest, responseHeaders, rangeFailure, type ProbeResponse, type ProbeInit } from "../engine/net/range-recovery";

export type CaptureMessage = Extract<BridgeToBackgroundMessage, { type: "capture" }>;

/** The slice of a fetch Response the capture probe actually reads. */
export interface CaptureFetchResponse extends ProbeResponse {
  text(): Promise<string>;
}

export interface CaptureDeps {
  readonly fetchFn: (
    url: string,
    init: ProbeInit,
  ) => Promise<CaptureFetchResponse>;
  /** Receives every descriptor that passed the surfacing gate. */
  readonly onDescriptor: (tabId: number, descriptor: StreamDescriptor) => void;
  readonly onFailure?: (tabId: number, failure: DiscoveryFailure) => void;
  readonly onProbeSuccess?: (tabId: number, url: string) => void;
  readonly logger?: Logger;
}

export type CaptureHandler = ((tabId: number, msg: CaptureMessage) => Promise<void>) & {
  clearTab(tabId: number): void;
};

export function createCaptureHandler(deps: CaptureDeps): CaptureHandler {
  const tabs = new Map<number, { controller: AbortController; pending: Map<string, Promise<void>> }>();
  function clearTab(tabId: number): void {
    const state = tabs.get(tabId);
    state?.controller.abort();
    tabs.delete(tabId);
  }
  function handleCapture(tabId: number, msg: CaptureMessage): Promise<void> {
    let state = tabs.get(tabId);
    if (!state) { state = { controller: new AbortController(), pending: new Map() }; tabs.set(tabId, state); }
    const key = JSON.stringify([msg.payload.kind === "eme", msg.payload.url, msg.payload.audioUrl, msg.payload.keySystem]);
    const existing = state.pending.get(key);
    if (existing) return existing;
    const current = state;
    const pending = capture(tabId, msg, current.controller.signal).finally(() => current.pending.delete(key));
    current.pending.set(key, pending);
    return pending;
  }
  async function capture(tabId: number, msg: CaptureMessage, signal: AbortSignal): Promise<void> {
    const cap = msg.payload;
    if (!cap.url && cap.kind !== "eme") return;

    const headers: Record<string, string> = cap.responseHeaders ? { ...cap.responseHeaders } : {};
    let bodyBytes: Uint8Array | null = null;
    let manifestText: string | null = null;

    if (cap.url) {
      try {
        const url = cap.url;
        let manifest = /\.(m3u8|mpd)([?#]|$)/i.test(url);
        if (!manifest) {
          // Video Rescue probes the observed URL independently of its filename.
          // Extensionless media needs the same bounded range request as .mp4.
          const probe = await probeMedia(deps.fetchFn, url, signal);
          delete headers["content-range"];
          Object.assign(headers, probe.headers);
          bodyBytes = probe.bytes;
          const prefix = new TextDecoder().decode(probe.bytes).trimStart();
          manifest = /(mpegurl|dash\+xml)/i.test(probe.headers["content-type"] ?? "")
            || /^(#EXTM3U|<\?xml|<MPD(?:\s|>))/.test(prefix);
        }
        if (manifest) {
          // A prefix cannot parse a full playlist. Re-fetch extensionless
          // manifests without Range after identifying their MIME or signature.
          const probe = await recoverRequest(async signal => {
            const r = await deps.fetchFn(url, { credentials: "include", signal });
            try {
              checkResponseStatus(r);
              const h = responseHeaders(r);
              return { headers: h, text: await r.text() };
            } finally {
              try { await r.body?.cancel(); } catch { /* already consumed */ }
            }
          }, signal);
          delete headers["content-range"];
          Object.assign(headers, probe.headers);
          manifestText = probe.text;
          bodyBytes = null;
        }
      } catch (err) {
        if (signal.aborted) return;
        deps.logger?.debug("capture fetch failed", { err: err instanceof Error ? err.name : "probe failed" });
        if (cap.kind !== "eme") {
          deps.onFailure?.(tabId, { url: cap.url, error: rangeFailure(err, cap.url,
            /\.(m3u8|mpd)([?#]|$)/i.test(cap.url) ? "manifest" : "direct") });
          return;
        }
      }
      if (signal.aborted) return;
      if (cap.kind !== "eme") deps.onProbeSuccess?.(tabId, cap.url);
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
        await probeDeclaredBytes(deps, cap.audioUrl, signal),
      )
      : classified;

    if (signal.aborted || !shouldSurfaceDescriptor(descriptor)) return;
    deps.onDescriptor(tabId, descriptor);
  }
  return Object.assign(handleCapture, { clearTab });
}

export function shouldSurfaceDescriptor(descriptor: StreamDescriptor): boolean {
  if (descriptor.drm) return true;
  if (descriptor.capabilities.directDownload) return true;
  return descriptor.protocol === "hls" || descriptor.protocol === "dash";
}

/**
 * Range-probe a companion track for its declared byte total so the browser
 * output-size guard counts both halves of a demuxed pair. Any failure yields
 * null — the size stays unknown rather than wrong.
 */
async function probeDeclaredBytes(deps: CaptureDeps, url: string, signal: AbortSignal): Promise<number | null> {
  try {
    const r = await deps.fetchFn(url, {
      credentials: "include",
      signal,
      headers: { range: "bytes=0-0" },
    });
    try { await r.body?.cancel(); } catch { /* stream already closed */ }
    checkResponseStatus(r);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
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
