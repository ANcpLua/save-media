// One frame's facts for the background's selector: its videos, what they
// declare, where they are, and what lies under the pointer. Collected in one
// synchronous pass on request. Nothing here waits, observes or decides.
import type { FileSaveProblem } from "../types/messages";
import type { ElementFact, ElementSource, FrameFacts, PageFileState, PointerFact, Rect } from "../types/page-facts";
import { FACT_LIMITS } from "../util/fact-limits";
import { canvasFeed, hasPlayed, notRenderedIndex } from "./canvas-feed";
import { declaredMedia } from "./declarations";
import { declaredMediaFilename, fileDownloadOffer } from "./discovery";
import { childFrames, framePath, renderState, type RenderState } from "./geometry";
import { parentAcrossShadow, walkMedia } from "./media-tree";
import { pointerLayers } from "./pointer-media";

const THUMB_WIDTH = 160;
const MAX_THUMBNAILS = 12;
const MAX_THUMBNAIL_CHARS = 200_000;

export interface PointerRecord { readonly x: number; readonly y: number; readonly at: number; readonly overFrame: number | null }

export interface CollectOptions {
  readonly pointer: boolean;
  readonly thumbnails: boolean;
  readonly pointerRecord: PointerRecord | null;
  readonly keyOf: (element: Element) => string;
  /** Elements that used a key (an encrypted event or a licence request), with the key system when known. */
  readonly keyed: { has(element: Element): boolean; get(element: Element): string | null | undefined };
  readonly fileSaveProblem: FileSaveProblem | null;
}

function sourceOf(video: HTMLVideoElement): ElementSource {
  const object = video.srcObject;
  if (object) return typeof MediaStream !== "undefined" && object instanceof MediaStream ? { kind: "stream" } : { kind: "media-source" };
  const src = video.currentSrc || video.src || video.querySelector<HTMLSourceElement>(":scope > source[src]")?.src || "";
  if (src.startsWith("blob:")) return { kind: "blob", url: src };
  return /^https?:\/\//i.test(src) ? { kind: "url", url: src.split("#", 1)[0]! } : { kind: "none" };
}

function captureFrame(video: HTMLVideoElement): string | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  try {
    const canvas = video.ownerDocument.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.max(1, Math.round(THUMB_WIDTH * video.videoHeight / video.videoWidth));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.6);
    return data.length <= MAX_THUMBNAIL_CHARS ? data : null;
  } catch {
    // Frames of cross-origin media taint the canvas.
    return null;
  }
}

function absolute(url: string, base: string): string | null {
  try {
    const parsed = new URL(url, base);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch { return null; }
}

function insideFullscreen(video: Element, fullscreen: Element | null): boolean {
  for (let current: Element | null = video; current && fullscreen; current = parentAcrossShadow(current)) {
    if (current === fullscreen) return true;
  }
  return false;
}

function area(rect: Rect | null): number {
  return rect ? rect.width * rect.height : 0;
}

export function collectFrameFacts(doc: Document, options: CollectOptions): FrameFacts {
  const win = doc.defaultView!;
  const top = win.top === win;
  const pageUrl = win.location.href;
  const tree = walkMedia(doc);
  const states = new Map<HTMLVideoElement, RenderState>(tree.videos.map(video => [video, renderState(video, win)]));
  const hidden = tree.videos.filter(video => states.get(video)!.render === "hidden");
  const notRendered = notRenderedIndex(hidden);

  // A hidden video counts as shown through a canvas only when the canvas
  // contains it or it has played: a never-played preview next to a chart is
  // not what the chart shows.
  const fedCanvas = new Map<HTMLVideoElement, Rect>();
  for (const canvas of tree.canvases) {
    const visible = renderState(canvas, win).visible;
    if (!visible) continue;
    const feed = canvasFeed(canvas, notRendered);
    if (feed.kind !== "element" || (feed.via !== "child" && !hasPlayed(feed.video))) continue;
    if (area(visible) > area(fedCanvas.get(feed.video) ?? null)) fedCanvas.set(feed.video, visible);
  }

  const pip = doc.pictureInPictureElement ?? null;
  const fullscreen = doc.fullscreenElement ?? null;
  const eligible = tree.videos.filter(video => states.get(video)!.render !== "hidden" || fedCanvas.has(video)
    || video === pip || insideFullscreen(video, fullscreen) || hasPlayed(video));
  const declared = declaredMedia(doc, pageUrl, eligible, options.keyOf);

  let thumbnails = 0;
  const elements: ElementFact[] = tree.videos.map(video => {
    const state = states.get(video)!;
    const key = options.keyOf(video);
    const playing = !video.paused && !video.ended && video.readyState >= 2;
    const canvas = fedCanvas.get(video) ?? null;
    const wantThumbnail = options.thumbnails && thumbnails < MAX_THUMBNAILS && (state.render !== "hidden" || canvas !== null);
    const poster = video.poster ? absolute(video.poster, doc.baseURI) : null;
    // Only a frame captured here is shown as a preview. A poster is an address of the page's choosing,
    // and the popup would request it from the extension with the user's cookies.
    const thumbnail = wantThumbnail ? captureFrame(video) : undefined;
    if (thumbnail) thumbnails++;
    return {
      key,
      source: sourceOf(video),
      groups: declared.byElement.get(key) ?? [],
      render: state.render,
      box: state.box,
      visible: state.visible,
      canvas,
      playing,
      played: hasPlayed(video),
      audible: playing && !video.muted && video.volume > 0,
      muted: video.muted || video.volume === 0,
      duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
      live: video.duration === Infinity,
      pip: video === pip,
      fullscreen: insideFullscreen(video, fullscreen),
      keyed: options.keyed.has(video) ? { keySystem: options.keyed.get(video) ?? null } : null,
      width: video.videoWidth || Math.round(state.box.width),
      height: video.videoHeight || Math.round(state.box.height),
      poster,
      ...(thumbnail === undefined ? {} : { thumbnail }),
    };
  });

  let pointer: PointerFact | null = null;
  const record = options.pointer ? options.pointerRecord : null;
  if (record) {
    pointer = { at: record.at, x: record.x, y: record.y, overFrame: record.overFrame, layers: pointerLayers(doc, record.x, record.y, {
      videos: tree.videos,
      rendered: new Set(tree.videos.filter(video => states.get(video)!.render !== "hidden")),
      notRendered,
      keyOf: options.keyOf,
      thumbnails: new Set(declared.thumbnails),
      playerStills: new Set(declared.playerStills),
      frameIndex: element => frameIndexOf(win, element),
    }) };
  }

  return {
    url: pageUrl,
    top,
    path: framePath(win),
    viewport: { width: win.innerWidth, height: win.innerHeight },
    childFrames: childFrames(doc, win),
    elements,
    pageGroups: declared.page,
    pointer,
    ...(top ? { page: pageFileState(doc, pageUrl, options.fileSaveProblem) } : {}),
  };
}

/** The position of a frame element's window in window.frames, or null. */
export function frameIndexOf(win: Window, element: Element): number | null {
  const child = (element as HTMLIFrameElement).contentWindow;
  if (!child) return null;
  for (let index = 0; index < win.length; index++) {
    try { if (win[index] === child) return index; } catch { /* A frame that went away. */ }
  }
  return null;
}

/** The page's declared file link, or else the file name it shows without one. */
export function pageFileState(doc: Document, pageUrl: string, problem: FileSaveProblem | null): PageFileState {
  const title = (doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() || doc.title).slice(0, FACT_LIMITS.title);
  const offer = fileDownloadOffer(doc, pageUrl);
  const namedFile = offer ? undefined : declaredMediaFilename(doc, { transport: false });
  return { title, ...(offer ? { fileDownload: offer } : {}), ...(namedFile ? { namedFile } : {}), fileSaveProblem: problem };
}
