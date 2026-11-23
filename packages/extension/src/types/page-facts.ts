// Facts a frame's content script reports about its document. Type-only: the
// classic content scripts and the background share these shapes without
// sharing runtime code.
import type { FileDownloadOffer, FileSaveProblem } from "./messages";

export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface DeclaredSource {
  readonly url: string;
  readonly groupId: string;
  readonly height?: number;
  readonly mime?: string;
  readonly filenameHint?: string;
}

/** Sources the page's own data declares as renditions of one video. */
export interface DeclaredGroup {
  readonly groupId: string;
  readonly via: "element" | "attribute" | "script" | "json-ld" | "og" | "link";
  /** 0 the video's own attributes, 1 JSON on its ancestors, 2 scripts in its container, 3 the page. */
  readonly proximity: 0 | 1 | 2 | 3;
  /** The page's declared main entity, or the file link of the file the page names. */
  readonly primary: boolean;
  readonly sources: readonly DeclaredSource[];
}

export type ElementSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "blob"; readonly url: string }
  | { readonly kind: "media-source" }
  | { readonly kind: "stream" }
  | { readonly kind: "none" };

export interface ElementFact {
  readonly key: string;
  readonly source: ElementSource;
  readonly groups: readonly DeclaredGroup[];
  readonly render: "visible" | "offscreen" | "hidden";
  readonly box: Rect;
  readonly visible: Rect | null;
  /** The visible rect of the canvas this video feeds, when it is not rendered itself. */
  readonly canvas: Rect | null;
  readonly playing: boolean;
  readonly played: boolean;
  /** Playing with sound: not muted and a volume above zero. */
  readonly audible: boolean;
  /** Muted, or at volume zero. A browser starts playback with sound only after the user acted. */
  readonly muted: boolean;
  readonly duration: number | null;
  readonly live: boolean;
  readonly pip: boolean;
  readonly fullscreen: boolean;
  /** Set only after the element used a key: an encrypted event or a licence request. */
  readonly keyed: { readonly keySystem: string | null } | null;
  readonly width: number;
  readonly height: number;
  readonly poster: string | null;
  readonly thumbnail?: string | null;
}

export type CanvasFeedFact =
  | { readonly kind: "element"; readonly key: string }
  | { readonly kind: "several-playing" }
  | { readonly kind: "none" };

export type PointerLayer =
  | { readonly kind: "video"; readonly key: string; readonly via: "stack" | "geometry" }
  | { readonly kind: "canvas"; readonly feed: CanvasFeedFact }
  /**
   * `belowCanvas`: a canvas lies above the image at the point, so the image is not what the user sees there.
   * `loaded`: an img element that shows the picture at `url`: the browser fetched and decoded it (`complete`
   * and a natural width). The content script reads this in its own world, where page scripts cannot change
   * what it sees. A background image, and an img that is broken or still loading, is false.
   */
  | { readonly kind: "image"; readonly url: string; readonly decorative: boolean; readonly posterOf: string | null;
      readonly declaredThumbnail: boolean; readonly belowCanvas: boolean; readonly loaded: boolean }
  | { readonly kind: "frame"; readonly index: number };

export interface PointerFact {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly overFrame: number | null;
  readonly layers: readonly PointerLayer[];
}

export interface PageFileState {
  readonly title: string;
  readonly fileDownload?: FileDownloadOffer;
  readonly namedFile?: string;
  readonly fileSaveProblem?: FileSaveProblem | null;
}

export interface ChildFrameFact { readonly index: number; readonly box: Rect; readonly visible: Rect | null }

export interface FrameFacts {
  readonly url: string;
  readonly top: boolean;
  /** The window.frames index chain from the top window, or null when it cannot be read. */
  readonly path: readonly number[] | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly childFrames: readonly ChildFrameFact[];
  readonly elements: readonly ElementFact[];
  readonly pageGroups: readonly DeclaredGroup[];
  readonly pointer: PointerFact | null;
  readonly page?: PageFileState;
}

export interface CollectedFrame extends FrameFacts {
  readonly frameId: number;
  readonly documentId: string | null;
  /**
   * The frame's route generation when its facts were read. A route change inside the page raises the
   * frame's generation: facts read before it describe the route before.
   */
  readonly generation?: number;
}

export interface TabFacts {
  /** The top frame's content script answered. */
  readonly reachable: boolean;
  readonly frames: readonly CollectedFrame[];
}

/** What the one selection says about the tab's main video. */
export type SelectionState = "ready" | "protected" | "unsupported" | "failed" | "live" | "ad-playing"
  | "ambiguous" | "not-loaded-yet" | "file-not-received" | "no-media" | "site-not-saved" | "reader-found-nothing";

/**
 * The tab's page is on a site whose media savemedia takes from a site reader alone: what the browser itself
 * loads there is not observed (background/network-capture.ts). "reader": this build has the reader.
 * "left-out": this build leaves the reader out, and saves nothing from the site in the browser.
 */
export type ManagedSite = "reader" | "left-out";

export interface PreviewView {
  readonly thumbnail: string | null;
  readonly width: number;
  readonly height: number;
  readonly duration: number | null;
}

/** The selection as the popup renders it. Ids are stream ids. */
export interface SelectionView {
  readonly state: SelectionState;
  readonly mainId: string | null;
  /** The main video was chosen through a media element: the popup marks its card "Main". */
  readonly elementMain: boolean;
  readonly mainName: string | null;
  /** The file name the page shows, when nothing the browser received can be that file. */
  readonly namedPending?: string;
  readonly cards: readonly { readonly ids: readonly string[]; readonly live: boolean }[];
  /** What a page's ad responses named and the browser loaded: listed apart, last, one card each. Not counted. */
  readonly ads?: readonly { readonly ids: readonly string[]; readonly live: boolean }[];
}
