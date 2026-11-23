import type { StreamDescriptor, StreamId, Variant } from "@savemedia/core";
import type { Origin, TabMediaState, Via } from "../../../src/background/tab-media";
import { emptyTabMediaState } from "../../../src/util/tab-media-state";
import { select, type Selection, type SelectionInput } from "../../../src/selection/main-video";
import type { CollectedFrame, DeclaredGroup, ElementFact, PointerLayer, TabFacts } from "../../../src/types/page-facts";
import { directDescriptor, hlsDescriptor } from "../popup/helpers/descriptors";

export const PAGE = "https://site.test/watch";

export function el(key: string, over: Partial<ElementFact> = {}): ElementFact {
  const box = over.box ?? { x: 0, y: 0, width: 640, height: 360 };
  return { key, source: { kind: "none" }, groups: [], render: "visible", box, visible: over.render === "hidden" || over.render === "offscreen" ? null : box,
    canvas: null, playing: false, played: false, audible: false, muted: false, duration: null, live: false, pip: false, fullscreen: false,
    keyed: null, width: 640, height: 360, poster: null, ...over };
}

export function frame(frameId: number, over: Partial<CollectedFrame> = {}): CollectedFrame {
  return { frameId, documentId: `doc-${frameId}`, url: frameId === 0 ? PAGE : `https://player.test/embed/${frameId}`, top: frameId === 0,
    path: frameId === 0 ? [] : [0], viewport: { width: 1280, height: 720 }, childFrames: [], elements: [], pageGroups: [], pointer: null,
    ...(frameId === 0 ? { page: { title: "Page" } } : {}), ...over };
}

export const facts = (...frames: CollectedFrame[]): TabFacts => ({ reachable: frames.some(item => item.frameId === 0), frames });

export function media(over: Partial<TabMediaState> = {}): TabMediaState {
  return { ...emptyTabMediaState(), topDocument: "doc-0", ...over };
}

export const origin = (frameId = 0, via: Via[] = ["network-media"], generation = 0, scope: Origin["scope"] = null): Origin =>
  ({ frameId, documentId: `doc-${frameId}`, generation, via, scope });

export function direct(id: string, url: string, over: Partial<StreamDescriptor> = {}): StreamDescriptor {
  return directDescriptor({ id: id as StreamId, title: null, pageUrl: PAGE, source: { kind: "direct-url", url, headers: {} }, ...over });
}

export function hls(id: string, url: string, over: Partial<StreamDescriptor> = {}, variantUrls: readonly string[] = []): StreamDescriptor {
  const base = hlsDescriptor().variants[0]!;
  const variants: Variant[] = (variantUrls.length ? variantUrls : [url]).map((playlistUrl, index) => ({ ...base, id: `${id}-v${index}` as Variant["id"],
    segmentRef: { kind: "hls-segments", playlistUrl, initSegmentUrl: null, segmentUrls: [], encryption: null } }));
  return hlsDescriptor({ id: id as StreamId, title: null, pageUrl: PAGE,
    source: { kind: "hls-manifest", manifestUrl: url, type: variantUrls.length ? "master" : "media" }, variants, ...over });
}

export function group(groupId: string, urls: readonly (string | [string, number])[], over: Partial<DeclaredGroup> = {}): DeclaredGroup {
  return { groupId, via: "attribute", proximity: 1, primary: false,
    sources: urls.map(item => typeof item === "string" ? { url: item, groupId } : { url: item[0], groupId, height: item[1] }), ...over };
}

export const video = (key: string): PointerLayer => ({ kind: "video", key, via: "stack" });
export const image = (url: string, over: Partial<Extract<PointerLayer, { kind: "image" }>> = {}): PointerLayer =>
  ({ kind: "image", url, decorative: false, posterOf: null, declaredThumbnail: false, belowCanvas: false, loaded: false, ...over });

export function input(over: Partial<SelectionInput>): SelectionInput {
  return { descriptors: [], failures: [], media: media(), jobs: new Set(), facts: null, usePointer: false, ...over };
}

/**
 * Select, and hold the selector to rule 11 on every call: the same input
 * gives a deeply equal selection, and the order descriptors arrived in does
 * not change it.
 */
export function run(over: Partial<SelectionInput>): Selection {
  const given = input(over);
  const first = select(given);
  expect(select(given)).toEqual(first);
  const reversed = select({ ...given, descriptors: [...given.descriptors].reverse(), failures: [...given.failures].reverse() });
  expect({ ...reversed, shownFailures: [...reversed.shownFailures].reverse() }).toEqual({ ...first, shownFailures: [...first.shownFailures] });
  return first;
}
