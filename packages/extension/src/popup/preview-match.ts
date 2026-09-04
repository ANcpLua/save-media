import type { StreamDescriptor } from "@savemedia/core";
import type { PageMediaSnapshot, PageVideo } from "../types/messages";

export interface Preview {
  readonly thumbnail: string | null;
  readonly width: number;
  readonly height: number;
  readonly duration: number | null;
}

export interface RankedDescriptor {
  readonly descriptor: StreamDescriptor;
  readonly preview: Preview | null;
  readonly isMain: boolean;
}

/**
 * Pair detected streams with the page's <video> elements and pick the main
 * one. Direct files match by URL; manifest streams (the player uses a blob:
 * source) attach to the blob-backed video, and when there is only one such
 * video every manifest entry gets its preview. "Main" is the video that is
 * playing on screen, else the largest visible one.
 */
export function rankDescriptors(
  descriptors: readonly StreamDescriptor[],
  snapshot: PageMediaSnapshot | null,
): RankedDescriptor[] {
  const videos = snapshot?.videos ?? [];
  const main = pickMain(videos);
  const blobVideos = videos.filter(v => v.src.startsWith("blob:"));

  const ranked = descriptors.map(descriptor => {
    const url = sourceUrl(descriptor);
    let video: PageVideo | undefined;
    if (url) video = videos.find(v => sameUrl(v.src, url));
    if (!video && !descriptor.capabilities.directDownload) {
      video = blobVideos.length === 1 ? blobVideos[0] : blobVideos.find(v => v === main);
    }
    return {
      descriptor,
      preview: video ? { thumbnail: video.thumbnail, width: video.width, height: video.height, duration: video.duration } : null,
      isMain: video !== undefined && video === main,
    };
  });

  return ranked.sort((a, b) => Number(b.isMain) - Number(a.isMain) || pixels(b.descriptor) - pixels(a.descriptor));
}

function pickMain(videos: readonly PageVideo[]): PageVideo | undefined {
  const onScreen = videos.filter(v => v.visible > 0.2);
  const playing = onScreen.filter(v => v.playing);
  const pool = playing.length > 0 ? playing : onScreen.length > 0 ? onScreen : videos;
  return [...pool].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

function sourceUrl(d: StreamDescriptor): string | null {
  switch (d.source.kind) {
    case "direct-url": return d.source.url;
    case "media-element": return d.source.elementSrc;
    default: return null;
  }
}

function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

function pixels(d: StreamDescriptor): number {
  return Math.max(0, ...d.variants.map(v => (v.width ?? 0) * (v.height ?? 0)));
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
