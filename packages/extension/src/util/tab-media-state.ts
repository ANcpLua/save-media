// The shape of what savemedia knows about a tab's media besides the
// descriptors, and the few rules that read it. Plain data, so it can be
// stored as it is. The background's store writes it; the selector reads it.
import type { Presentation, StreamDescriptor, StreamId } from "@savemedia/core";
import type { AdVia } from "../types/messages";
import type { TabFacts } from "../types/page-facts";
import { sourceAddress } from "./media-address";
import { playlistIdentity } from "./media-url";

export type Via = "network-media" | "network-fetch" | "timing" | "declared" | "metadata" | "file-link" | "element" | "eme" | "resolver";

/** Where a media address was seen. */
export interface Origin {
  readonly frameId: number;
  readonly documentId: string | null;
  /** The frame's route generation when the capture started. */
  readonly generation: number;
  readonly via: readonly Via[];
  /** Set for declared sources: read from a video element's own data, or from the page. */
  readonly scope: "element" | "page" | null;
  /** The origin of the document whose Referer the check of this address sent. A save's requests send the same. */
  readonly referrer?: string | null;
}

export interface Activity { readonly at: number; readonly frameId: number; readonly generation: number }

export interface ElementDrm { readonly id: StreamId; readonly keySystem: string | null; readonly elementSrc: string | null; readonly frameId: number }

/** `parent` is the frame's parent frame, when the browser reported it. */
export interface FrameState { documentId: string | null; url: string; generation: number; parent?: number }

export interface Received { readonly ip: string | null; readonly frameId: number }

/**
 * A video answer a document's own script fetched whole (fetch or XHR, status 200, a video type): which
 * frame and document asked, and the address of the server that answered (null for an answer from the
 * browser's cache). It may be a whole file the page then plays from memory, or a part of a stream.
 * Nothing is requested for it until the user looks at the page; then its first bytes say which it is.
 */
export interface Fetched { readonly frameId: number; readonly documentId: string | null; readonly ip: string | null }

/** The most fetched answers of one document that one look at the page asks about. A tab stores as many. */
export const FETCHED_PER_LOOK = 8;

export interface TabMediaState {
  topDocument: string | null;
  /** The tab's last top-level navigation failed: the tab shows the browser's own error page, not a document of a site. */
  loadFailed: boolean;
  frames: Record<number, FrameState>;
  /** Media address (without fragment and delivery directives) to where it was seen. */
  origins: Record<string, Origin>;
  /** Segment, init, playlist, manifest and file addresses to the address of the stream that owns them. */
  owners: Record<string, string>;
  /** Owner address to the page's last request for it or one of its parts. */
  activity: Record<string, Activity>;
  ads: Record<string, AdVia>;
  /** Interstitial asset lists a playlist announced. Never requested. */
  assetLists: string[];
  timelines: Record<string, Presentation>;
  /** elementDrmKey() to the protected element's descriptor. */
  elementDrm: Record<string, ElementDrm>;
  /** Addresses the browser itself received a 200 or 206 for in this tab, with the server address and the frame. */
  received: Record<string, Received>;
  /**
   * Origins (scheme, host and port) the browser itself received an answer from at an address inside the
   * user's network, in this tab's current document. Only the browser's own requests are noted here.
   */
  localOrigins: Record<string, true>;
  /** Video answers the page's own scripts fetched whole, not checked yet, by address. See Fetched. */
  fetched: Record<string, Fetched>;
  /**
   * What earlier top documents of this tab received, newest last. A page
   * restored from the back-forward cache is the same document again, and the
   * browser does not repeat its requests.
   */
  earlier: { documentId: string; received: Record<string, Received>; localOrigins?: Record<string, true>; fetched?: Record<string, Fetched> }[];
  /** The last collected facts, without thumbnails. */
  facts: TabFacts | null;
}

export function emptyTabMediaState(): TabMediaState {
  return { topDocument: null, loadFailed: false, frames: {}, origins: {}, owners: {}, activity: {}, ads: {}, assetLists: [], timelines: {}, elementDrm: {},
    received: {}, localOrigins: {}, fetched: {}, earlier: [], facts: null };
}

/** The document id a frame gets once the browser no longer lists it: no media can be of this document. */
export const REMOVED_FRAME = "savemedia:removed-frame";

/** The one name of a media element across the store, its protection descriptor and the selector. */
export function elementDrmKey(frameId: number, documentId: string | null, key: string | null): string {
  return `${documentId ?? `frame-${frameId}`}/${key ?? "document"}`;
}

/**
 * The address the row of a protected media element is named by: the element's own address, unless another
 * frame is known for that address. A frame that shows a copy of another frame's video and reports key use
 * says nothing about that video: its row is named by its own element, and where the other frame's video
 * was seen stays as it is.
 */
export function protectionRowAddress(origins: TabMediaState["origins"], frameId: number, documentId: string | null, key: string | null,
  elementSrc: string | null): string {
  const known = elementSrc ? origins[playlistIdentity(elementSrc)] : undefined;
  return elementSrc && (!known || known.frameId === frameId) ? elementSrc : `savemedia-element:${elementDrmKey(frameId, documentId, key)}`;
}

/** Every address that is a descriptor or belongs to one. The first is the stream's own. */
export function urlsOf(descriptor: StreamDescriptor): readonly string[] {
  const urls: string[] = [sourceAddress(descriptor, "entry"), sourceAddress(descriptor, "final")];
  if (descriptor.protocol === "hls") {
    for (const variant of [...descriptor.variants, ...(descriptor.audioRenditions ?? [])]) {
      if (variant.segmentRef.kind === "hls-segments") urls.push(variant.segmentRef.playlistUrl);
    }
  }
  return [...new Set(urls.map(playlistIdentity))];
}

/** Whether `frameId` is `ancestor` or a frame inside it, by the parents the browser reported. */
export function inFrameTree(frames: TabMediaState["frames"], frameId: number, ancestor: number): boolean {
  let current: number | undefined = frameId;
  for (let depth = 0; current !== undefined && current >= 0 && depth < 64; depth++) {
    if (current === ancestor) return true;
    current = frames[current]?.parent;
  }
  return false;
}
