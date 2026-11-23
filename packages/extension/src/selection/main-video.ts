// The one selector. The popup card, the Main badge, the toolbar count, Save
// and Alt+S all call select() and follow its answer. It is a pure function of
// facts: the same page state gives the same selection, and nothing about a
// selection is stored.
import type { StreamDescriptor, StreamId } from "@savemedia/core";
import { elementDrmKey, FETCHED_PER_LOOK, urlsOf, type Activity, type Origin, type TabMediaState, type Via } from "../util/tab-media-state";
import type { DiscoveryFailure } from "../types/messages";
import type { CollectedFrame, DeclaredGroup, DeclaredSource, ElementFact, ManagedSite, PreviewView, Rect, SelectionState, SelectionView, TabFacts } from "../types/page-facts";
import { compareDownloads, downloadOptions } from "../util/downloadable";
import { dispositionFileName, mediaFileName, nameFitsContainer, playlistIdentity } from "../util/media-url";
import { area, composeFrames, intersect, toTop } from "./frame-geometry";
import { resolvePointer, type ElementRef } from "./pointer-target";

export type { ElementRef } from "./pointer-target";

export interface SelectionInput {
  readonly descriptors: readonly StreamDescriptor[];
  readonly failures: readonly DiscoveryFailure[];
  readonly media: Readonly<TabMediaState>;
  /** Ids of descriptors with a running job. */
  readonly jobs: ReadonlySet<string>;
  readonly facts: TabFacts | null;
  readonly usePointer: boolean;
  /** Set when the tab's page is on a site that is read by a site reader alone. */
  readonly site?: ManagedSite | null;
}

/** A declared or element source worth one bounded check on the user's request. */
export interface ProbeRequest {
  readonly url: string;
  readonly frameId: number;
  readonly documentId: string | null;
  readonly frameUrl: string;
  readonly scope: "element" | "page";
  /** "fetched": an answer a script of the frame's document fetched whole. It is listed only when its bytes begin a whole file. */
  readonly via: "element" | "declared" | "metadata" | "file-link" | "fetched";
  /** The address failed its last check. It is checked again only when the user asks for it. */
  readonly retry: boolean;
  readonly height?: number;
  readonly groupId?: string;
  readonly filenameHint?: string;
}

export interface Card { readonly ids: readonly StreamId[]; readonly live: boolean; readonly element: ElementRef | null }

export interface Selection {
  readonly state: SelectionState;
  readonly main: StreamId | null;
  /** The main and its other renditions, best first. Save starts the first that can be saved. */
  readonly candidates: readonly StreamId[];
  /** Set when the main came from a media element: the popup's Main badge. */
  readonly element: ElementRef | null;
  readonly reason: "pointer" | "picture-in-picture" | "fullscreen" | "playing" | "visible" | "offscreen" | "page" | null;
  /** The file name the page shows for the main, when the server gave it none and the file's own bytes are of that kind. */
  readonly mainName: string | null;
  /**
   * The file name the page shows, when nothing the browser received can be that file: every file it received
   * is of another kind than the name says, or it received streams only. What is listed is then something
   * else (a preview), is not given the page's name, and the user is told that the named file has not arrived.
   */
  readonly namedPending: string | null;
  /** The failure that explains the state "failed". */
  readonly failure: DiscoveryFailure | null;
  /** The key system of a protected element that has no descriptor yet. */
  readonly keySystem: string | null;
  /** The pointer is on a video made inside the page (a camera or screen stream). */
  readonly streamSource: boolean;
  /** The video the answer is about is playing now: no hint asks the user to start it. */
  readonly targetPlaying: boolean;
  readonly image: { readonly url: string; readonly pageUrl: string; readonly loaded: boolean } | null;
  /** Checks that can improve the answer. The caller runs them and selects again. */
  readonly toProbe: readonly ProbeRequest[];
  /**
   * Checked only when the popup lists the page: the own sources of other visible players, and sources that
   * failed before and cannot change a ready answer (checked again by "Check page again", never by a save).
   */
  readonly listProbe: readonly ProbeRequest[];
  readonly cards: readonly Card[];
  /**
   * What a page's ad responses named and the browser itself loaded, one card each. They are listed last and
   * apart, are never the main video and count nowhere. The user may save one from its card.
   */
  readonly ads: readonly Card[];
  readonly previews: Readonly<Record<string, PreviewView>>;
  readonly shownFailures: readonly DiscoveryFailure[];
}

interface Info {
  readonly d: StreamDescriptor;
  readonly urls: readonly string[];
  readonly ad: boolean;
  readonly origin: Origin | null;
  readonly current: boolean;
  readonly currentRoute: boolean;
  readonly activity: Activity | null;
  readonly live: boolean;
  readonly downloadable: boolean;
  readonly duration: number | null;
  readonly maxSegment: number | null;
  element: El | null;
  listed: boolean;
}

interface El {
  readonly ref: ElementRef;
  readonly fact: ElementFact;
  readonly frame: CollectedFrame;
  readonly depth: number;
  /** Where the element shows in the top window, or null when none of it does. */
  readonly box: Rect | null;
  readonly area: number;
  readonly eligible: boolean;
  readonly ad: boolean;
  readonly sourceUrl: string | null;
  readonly assigned: Info[];
}

interface Decision {
  readonly state: SelectionState;
  readonly main: Info | null;
  readonly candidates: readonly Info[];
  readonly failure?: DiscoveryFailure | null;
  readonly keySystem?: string | null;
  readonly streamSource?: boolean;
  /** The answer is about the target element itself, not the page's fallback. */
  readonly byElement?: boolean;
  /** The media was picked among the document's streams, not told to be this element's: no Main badge. */
  readonly pageChoice?: boolean;
}

const MAX_PROBES = 20;
const refKey = (ref: ElementRef): string => `${ref.frameId}/${ref.key}`;

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return b[index]! - a[index]!;
  }
  return 0;
}

function serverNamed(descriptor: StreamDescriptor): boolean {
  return descriptor.source.kind === "direct-url"
    && mediaFileName(dispositionFileName(descriptor.source.headers["content-disposition"])) !== undefined;
}

// select() is a chain of stages. Each is a function of its arguments alone:
// what is known (the scene), who plays what (association), what is listed,
// what the pointer is on, the decision with the checks that could improve
// it, and what the popup shows. Nothing is kept between two calls.

/** What is known about the tab: its streams and its media elements, with the lookups every later stage reads. */
interface Scene {
  readonly media: Readonly<TabMediaState>;
  readonly frames: readonly CollectedFrame[];
  readonly infos: readonly Info[];
  readonly byUrl: ReadonlyMap<string, Info>;
  readonly failureByUrl: ReadonlyMap<string, DiscoveryFailure>;
  readonly elements: readonly El[];
  readonly elementByRef: ReadonlyMap<string, El>;
}

const isAdUrl = (scene: Pick<Scene, "media">, url: string): boolean => scene.media.ads[playlistIdentity(url)] !== undefined;
const generationOf = (scene: Pick<Scene, "media">, frameId: number): number => scene.media.frames[frameId]?.generation ?? 0;
const documentOf = (scene: Pick<Scene, "media" | "frames">, frameId: number): string | null =>
  scene.media.frames[frameId]?.documentId ?? scene.frames.find(frame => frame.frameId === frameId)?.documentId ?? null;
const depthOf = (scene: Pick<Scene, "frames">, frameId: number): number =>
  scene.frames.find(frame => frame.frameId === frameId)?.path?.length ?? (frameId === 0 ? 0 : 1);
const groupUrls = (group: DeclaredGroup): string[] => group.sources.map(source => playlistIdentity(source.url));

/** Stage 1: every descriptor and every media element, with what the tab's state says about each. */
function describeScene(input: SelectionInput): Scene {
  const { media, facts } = input;
  const frames = facts?.frames ?? [];
  const transforms = composeFrames(frames);
  const base = { media, frames };

  const infos: Info[] = input.descriptors.map(d => {
    const urls = urlsOf(d);
    let origin: Origin | null = null;
    let activity: Activity | null = null;
    for (const url of urls) {
      const seen = media.origins[url];
      if (seen && (!origin || seen.generation > origin.generation)) origin = seen;
      const used = media.activity[url];
      if (used && (!activity || used.at > activity.at)) activity = used;
    }
    const timelines = urls.slice(1).map(url => media.timelines[url]).filter(item => item !== undefined);
    const presentation = d.presentation ?? timelines[0] ?? null;
    const known = origin?.documentId ?? null;
    const now = origin ? documentOf(base, origin.frameId) : null;
    return {
      d, urls, origin, activity,
      ad: urls.some(url => isAdUrl(base, url)),
      current: known === null || now === null || known === now,
      currentRoute: (!origin || origin.generation === generationOf(base, origin.frameId))
        || (!!activity && activity.generation === generationOf(base, activity.frameId)),
      live: d.presentation?.live === true || timelines.some(item => item.live),
      downloadable: downloadOptions(d).length > 0,
      duration: presentation?.durationSeconds ?? null,
      maxSegment: presentation?.maxSegmentSeconds ?? null,
      element: null,
      listed: false,
    };
  });
  const byUrl = new Map<string, Info>();
  for (const info of infos) for (const url of info.urls) if (!byUrl.has(url)) byUrl.set(url, info);
  const failureByUrl = new Map(input.failures.map(failure => [playlistIdentity(failure.url), failure]));

  const elements: El[] = frames.flatMap(frame => frame.elements.map(fact => {
    const transform = transforms.get(frame.frameId);
    const sourceUrl = fact.source.kind === "url" ? playlistIdentity(fact.source.url) : null;
    const box = transform ? toTop(transform, fact.canvas ?? fact.visible) : null;
    return {
      ref: { frameId: frame.frameId, key: fact.key },
      fact, frame,
      depth: frame.path?.length ?? (frame.frameId === 0 ? 0 : 1),
      box,
      area: area(box),
      eligible: fact.source.kind !== "stream" && (fact.render !== "hidden" || fact.canvas !== null || fact.pip || fact.fullscreen),
      ad: sourceUrl !== null && isAdUrl(base, sourceUrl),
      sourceUrl,
      assigned: [],
    };
  }));
  return { media, frames, infos, byUrl, failureByUrl, elements, elementByRef: new Map(elements.map(element => [refKey(element.ref), element])) };
}

/**
 * The decided order of media elements. Picture-in-picture and fullscreen
 * first; then a video playing with sound; then one the user played with
 * sound and paused; then the largest and longest visible one; then a video
 * playing without sound that a larger or a longer visible video stands next
 * to; then videos out of view. Videos playing an ad and live streams come
 * last. A video playing without sound with nothing larger or longer beside
 * it (a feed's post) stays among the visible ones and gives way only on a tie.
 */
interface Ranking {
  readonly key: (element: El, live: boolean) => number[];
  /** `byAssociation`: a player whose streams are all live counts as live. */
  readonly rank: (list: readonly El[], byAssociation: boolean) => El[];
}

const silentlyPlaying = (fact: ElementFact): boolean => fact.playing && !fact.audible;
const elementLive = (element: El): boolean => element.fact.live || (element.assigned.length > 0 && element.assigned.every(info => info.live));

function rankingOf(scene: Scene): Ranking {
  const others = scene.elements.filter(element => element.eligible && !element.ad && element.area > 0 && !silentlyPlaying(element.fact));
  const outdone = (element: El): boolean => others.some(other =>
    other.area > element.area || (other.fact.duration ?? 0) > (element.fact.duration ?? 0));
  const key = (element: El, live: boolean): number[] => {
    const fact = element.fact;
    const inView = element.area > 0;
    const tier = !inView ? 0 : fact.audible ? 4 : fact.played && !fact.muted ? 3 : silentlyPlaying(fact) && outdone(element) ? 1 : 2;
    return [element.ad ? 0 : live ? 1 : 2, Number(fact.pip), Number(fact.fullscreen), tier, element.area, fact.duration ?? 0,
      silentlyPlaying(fact) ? 0 : 1, -element.depth];
  };
  const tieBreak = (a: El, b: El): number => (a.frame.path ?? []).join("/").localeCompare((b.frame.path ?? []).join("/"))
    || a.ref.frameId - b.ref.frameId || a.ref.key.localeCompare(b.ref.key, undefined, { numeric: true });
  return {
    key,
    rank: (list, byAssociation) => [...list].sort((a, b) =>
      compareKeys(key(a, byAssociation ? elementLive(a) : a.fact.live), key(b, byAssociation ? elementLive(b) : b.fact.live)) || tieBreak(a, b)),
  };
}

/** A page's declared groups without the sources its ad responses named. */
function cleanGroups(scene: Scene, groups: readonly DeclaredGroup[]): DeclaredGroup[] {
  return groups.map(group => ({ ...group, sources: group.sources.filter(source => !isAdUrl(scene, source.url)) }))
    .filter(group => group.sources.length > 0);
}

function nearestGroups(scene: Scene, element: El): DeclaredGroup[] {
  const groups = cleanGroups(scene, element.fact.groups);
  const nearest = Math.min(...groups.map(group => group.proximity));
  return groups.filter(group => group.proximity === nearest);
}

/** The one group that speaks for an element: the group listing its source, else its single nearest group. */
function groupOf(scene: Scene, element: El): DeclaredGroup | null {
  const groups = cleanGroups(scene, element.fact.groups);
  const own = element.sourceUrl ? groups.filter(group => groupUrls(group).includes(element.sourceUrl!)) : [];
  if (own.length) return [...own].sort((a, b) => b.sources.length - a.sources.length || a.proximity - b.proximity)[0]!;
  if (element.sourceUrl) return null;
  const nearest = nearestGroups(scene, element);
  return nearest.length === 1 ? nearest[0]! : null;
}

/** The row of a media element that used a key (background protectElement). */
const elementProtection = (info: Info): boolean => info.d.source.kind === "media-element" && !!info.d.drm;

/** Stage 2: each descriptor goes to at most one element. Writes `element` on the infos and `assigned` on the elements. */
function associate(scene: Scene, ranking: Ranking): void {
  const { media, frames, infos, elements } = scene;
  const candidates = infos.filter(info => !info.ad && info.current);
  const assign = (info: Info, element: El): void => {
    if (info.element) return;
    info.element = element;
    element.assigned.push(info);
  };
  const order = ranking.rank(elements, false);

  // A1: the element's own source, or a rendition its data lists next to that source. A protection row is of
  // the element that used the key and of no other (A2): an address it shares with another element, in this
  // frame or in any other, never makes that element protected.
  for (const element of order) {
    if (!element.sourceUrl) continue;
    const related = new Set([element.sourceUrl, ...cleanGroups(scene, element.fact.groups)
      .filter(group => groupUrls(group).includes(element.sourceUrl!)).flatMap(groupUrls)]);
    for (const info of candidates) {
      if (!info.element && !elementProtection(info) && info.urls.some(url => related.has(url))) assign(info, element);
    }
  }
  // A2: the element's own protection descriptor.
  for (const element of order) {
    const drm = media.elementDrm[elementDrmKey(element.ref.frameId, element.frame.documentId, element.ref.key)];
    const info = drm ? infos.find(item => item.d.id === drm.id) : undefined;
    if (info && !info.element) { info.element = element; element.assigned.push(info); }
  }
  // A3: an element without a source of its own, and exactly one group that declares one.
  for (const element of order) {
    if (element.sourceUrl) continue;
    const nearest = nearestGroups(scene, element);
    if (nearest.length !== 1) continue;
    const urls = new Set(groupUrls(nearest[0]!));
    for (const info of candidates) if (!info.element && info.urls.some(url => urls.has(url))) assign(info, element);
  }
  // A4: renditions of a group already assigned.
  for (let changed = true; changed;) {
    changed = false;
    for (const info of candidates) {
      if (info.element || !info.d.mediaGroup) continue;
      const sibling = candidates.find(other => other.element && other.d.mediaGroup === info.d.mediaGroup && other.d.pageUrl === info.d.pageUrl);
      if (sibling) { assign(info, sibling.element!); changed = true; }
    }
  }
  // A5: players fed through MediaSource, per document. Document order is never used.
  for (const frame of frames) {
    const players = elements.filter(element => element.ref.frameId === frame.frameId
      && (element.fact.source.kind === "blob" || element.fact.source.kind === "media-source"));
    if (!players.length) continue;
    const free = (): Info[] => candidates.filter(info => !info.element && (info.origin?.frameId ?? 0) === frame.frameId
      && (info.d.protocol === "hls" || info.d.protocol === "dash" || (info.origin?.via.includes("network-fetch") ?? false)));
    // a. The player's duration equals one stream's, within the longest segment that stream states.
    const matches = new Map<El, Info[]>(players.map(player => [player, player.fact.duration === null ? [] : free().filter(info =>
      info.duration !== null && info.maxSegment !== null && Math.abs(player.fact.duration! - info.duration) <= info.maxSegment)]));
    for (const [player, list] of matches) {
      if (list.length !== 1) continue;
      const claimed = [...matches].filter(([other, others]) => other !== player && others.includes(list[0]!));
      if (!claimed.length) assign(list[0]!, player);
    }
    // b. One live player and one live stream.
    const livePlayers = players.filter(player => player.fact.live && !player.assigned.length);
    const liveStreams = free().filter(info => info.live);
    if (livePlayers.length === 1 && liveStreams.length === 1) assign(liveStreams[0]!, livePlayers[0]!);
    const open = players.filter(player => !player.assigned.length);
    const latest = (list: readonly Info[]): Info | undefined => [...list].filter(info => info.activity)
      .sort((a, b) => b.activity!.at - a.activity!.at || a.d.id.localeCompare(b.d.id))[0];
    if (players.length === 1 && open.length === 1) {
      // c. The document's only such player takes the stream of the current route.
      const currentRoute = free().filter(info => info.currentRoute);
      const stream = currentRoute.length === 1 ? currentRoute[0] : currentRoute.length === 0 ? latest(free()) : undefined;
      if (stream) assign(stream, open[0]!);
    } else if (players.length > 1) {
      // d. Several players, one playing, and one stream of this route left over: it is that player's.
      // With several left, which request came last says nothing: pages fetch the next video ahead.
      const playing = players.filter(player => player.fact.playing);
      const left = free().filter(info => info.currentRoute);
      if (playing.length === 1 && !playing[0]!.assigned.length && left.length === 1) assign(left[0]!, playing[0]!);
    }
  }
}

/** What the tab lists: the page's media, the ads apart, and the media elements in their decided order. */
interface Listing {
  readonly listed: readonly Info[];
  /** An address named as an ad is listed apart. It is in none of the pools a main video is chosen from. */
  readonly ads: readonly Info[];
  readonly ranked: readonly El[];
}

const activityAt = (info: Info): number => info.activity?.at ?? 0;
const best = (list: readonly Info[]): Info[] => [...list].sort((a, b) =>
  compareDownloads(a.d, b.d) || activityAt(b) - activityAt(a) || a.d.id.localeCompare(b.d.id));
const usable = (info: Info): boolean => info.listed && info.downloadable && !info.live;
const withRenditions = (main: Info, pool: readonly Info[]): Info[] => [main, ...best(pool.filter(info => info !== main && usable(info)
  && !!main.d.mediaGroup && info.d.mediaGroup === main.d.mediaGroup && info.d.pageUrl === main.d.pageUrl))];

/** Stage 3: which descriptors are listed. Writes `listed` on the infos. */
function list(scene: Scene, ranking: Ranking, jobs: ReadonlySet<string>): Listing {
  for (const info of scene.infos) {
    info.listed = !info.ad && info.current && (info.currentRoute || info.element !== null || jobs.has(info.d.id));
  }
  return {
    listed: scene.infos.filter(info => info.listed),
    ads: scene.infos.filter(info => info.ad && info.current && (info.currentRoute || jobs.has(info.d.id))),
    ranked: ranking.rank(scene.elements.filter(element => element.eligible), true),
  };
}

function ready(listing: Listing, pool: readonly Info[]): Decision | null {
  const main = best(pool.filter(usable))[0];
  return main ? { state: "ready", main, candidates: withRenditions(main, listing.listed) } : null;
}

/** The streams a document loaded that no shown media element is known to play. */
function orphans(listing: Listing, frameId: number): Info[] {
  return listing.listed.filter(info => usable(info) && (info.origin?.frameId ?? 0) === frameId && (!info.element || !info.element.eligible));
}

// ---------- probes: a stage names the checks that could improve its answer, and returns them ----------

function needsProbe(scene: Scene, source: DeclaredSource, group: DeclaredGroup | null): "check" | "retry" | null {
  const key = playlistIdentity(source.url);
  if (isAdUrl(scene, key)) return null;
  const known = scene.byUrl.get(key);
  if (!known) return scene.failureByUrl.has(key) ? "retry" : "check";
  if (!known.d.capabilities.directDownload) return null;
  return (!!group && group.sources.length > 1 && known.d.mediaGroup !== group.groupId) || (!!source.filenameHint && !known.d.title)
    ? "check" : null;
}

/** The check of one declared or element source, when one can improve the answer. */
function probeOf(scene: Scene, frame: CollectedFrame, source: DeclaredSource, group: DeclaredGroup | null, scope: "element" | "page"): ProbeRequest[] {
  const need = needsProbe(scene, source, group);
  if (!need) return [];
  const via = !group || group.via === "element" ? "element" : group.via === "link" ? "file-link"
    : group.via === "json-ld" || group.via === "og" ? "metadata" : "declared";
  return [{
    url: source.url, frameId: frame.frameId, documentId: frame.documentId, frameUrl: frame.url, scope, via, retry: need === "retry",
    ...(source.height ? { height: source.height } : {}),
    ...(group && group.sources.length > 1 ? { groupId: group.groupId } : {}),
    ...(source.filenameHint ? { filenameHint: source.filenameHint } : {}),
  }];
}

/**
 * The checks of what a player's document fetched whole and nothing has looked at yet: a page that fetches
 * a video file and plays it from memory shows the file nowhere else. Asked only for a player that plays
 * from memory and has no stream of its own. The newest answers come first.
 */
function fetchedProbes(scene: Scene, element: El): ProbeRequest[] {
  const document = documentOf(scene, element.ref.frameId);
  return Object.entries(scene.media.fetched).reverse()
    .filter(([url, fetched]) => fetched.frameId === element.ref.frameId && (fetched.documentId === null || document === null || fetched.documentId === document)
      && !isAdUrl(scene, url) && !scene.byUrl.has(url))
    .slice(0, FETCHED_PER_LOOK)
    .map(([url]) => ({ url, frameId: element.ref.frameId, documentId: element.frame.documentId, frameUrl: element.frame.url, scope: "element" as const,
      via: "fetched" as const, retry: scene.failureByUrl.has(url) }));
}

const groupProbes = (scene: Scene, frame: CollectedFrame, group: DeclaredGroup, scope: "element" | "page"): ProbeRequest[] =>
  group.sources.flatMap(source => probeOf(scene, frame, source, group, scope));

/**
 * The requests in the order they were named, one per address, at most
 * MAX_PROBES: a later request for the same address replaces the earlier one
 * in its place, and nothing is taken once the limit is reached.
 */
function collectProbes(requests: readonly ProbeRequest[]): Map<string, ProbeRequest> {
  const kept = new Map<string, ProbeRequest>();
  for (const request of requests) {
    if (kept.size >= MAX_PROBES) break;
    kept.set(playlistIdentity(request.url), request);
  }
  return kept;
}

// ---------- failures ----------

interface Failures {
  /** The failures of the documents the tab shows now, without those of ad addresses. */
  readonly current: readonly DiscoveryFailure[];
  /** A page's metadata often names its embed page, not a file. That answer is never an error to show. */
  readonly quiet: (failure: DiscoveryFailure) => boolean;
  /**
   * The failure of an address a document itself asked for, of `frameId`'s document or of any. It explains a
   * player that has no media: its page tried to load some, and that did not work. The failure of an address
   * a page's data only names explains nothing about a player that has not asked for anything yet.
   */
  readonly asked: (frameId?: number) => DiscoveryFailure | undefined;
}

const REQUESTED: readonly Via[] = ["network-media", "network-fetch", "timing"];

function failuresOf(scene: Scene, failures: readonly DiscoveryFailure[]): Failures {
  const originOf = (failure: DiscoveryFailure): Origin | null => scene.media.origins[playlistIdentity(failure.url)] ?? null;
  const current = failures.filter(failure => {
    const origin = originOf(failure);
    const now = origin ? documentOf(scene, origin.frameId) : null;
    return !isAdUrl(scene, failure.url) && (!origin?.documentId || now === null || origin.documentId === now);
  });
  const quiet = (failure: DiscoveryFailure): boolean => {
    const origin = originOf(failure);
    return origin?.scope === "page" && origin.via.includes("metadata")
      && failure.error.code === "unexpected_media_response" && failure.error.response === "page";
  };
  return {
    current, quiet,
    asked: frameId => current.find(failure => {
      const origin = originOf(failure);
      return !quiet(failure) && !!origin && origin.via.some(via => REQUESTED.includes(via)) && (frameId === undefined || origin.frameId === frameId);
    }),
  };
}

// ---------- decisions: each returns its answer and the checks that could improve it ----------

/** A player the page has given no source yet. */
const waitsForSource = (element: El): boolean => !element.ad && element.fact.render !== "hidden" && element.fact.source.kind === "none";

/**
 * Whether an ad that plays is what holds a video back. The one rule, for the page's answer and for a
 * player's: an ad video plays in a waiting player's own document, or lies over that player in the window
 * (an ad frame laid over the player, or an ad of the page over a player frame). An ad that plays in a
 * frame of its own beside the player, such as a sidebar ad, says nothing about that player. Where no
 * player waits at all, an ad that plays is all the page shows.
 */
function adHoldsBack(scene: Scene, players: readonly El[]): boolean {
  const ads = scene.elements.filter(element => element.ad && element.fact.playing);
  if (!ads.length) return false;
  if (!players.length) return true;
  return ads.some(ad => players.some(player => ad.ref.frameId === player.ref.frameId || intersect(ad.box, player.box) !== null));
}

interface Decided<T> { readonly answer: T; readonly probes: readonly ProbeRequest[] }

/**
 * A ready answer does not wait for a source that failed its last check. The check of such a source is asked
 * for again only where it may be another rendition of the answer: an address a declared group lists next to
 * `own`, the target player's own source, or for the page's answer next to the answer itself. Every other
 * failed source is left to the user's next look at the page (`later`): a player fed through MediaSource
 * whose stream is captured is saved at once, and never waits again for an address its page data names and
 * the server no longer answers.
 */
function withoutIdleRetries(scene: Scene, decided: Decided<Decision>, own: readonly string[]): Decided<Decision> & { readonly later: readonly ProbeRequest[] } {
  const { answer, probes } = decided;
  if (answer.state !== "ready" || !probes.some(probe => probe.retry)) return { ...decided, later: [] };
  const groups = scene.frames.flatMap(frame => [...frame.pageGroups, ...frame.elements.flatMap(fact => fact.groups)]).map(groupUrls);
  const beside = new Set(groups.filter(urls => own.some(url => urls.includes(url))).flat().concat(own));
  const waits = (probe: ProbeRequest): boolean => !probe.retry || beside.has(playlistIdentity(probe.url));
  return { answer, probes: probes.filter(waits), later: probes.filter(probe => !waits(probe)) };
}

/** Stage 5a: the page's own answer, for a tab without a target element or one that leaves the answer to the page. */
function pageFallback(scene: Scene, listing: Listing, failures: Failures, affinity: number | null): Decided<Decision> {
  const { listed } = listing;
  const topFrame = scene.frames.find(frame => frame.top) ?? null;
  const pageState = topFrame?.page ?? null;
  const probes: ProbeRequest[] = [];
  const done = (answer: Decision): Decided<Decision> => ({ answer, probes });
  const pageGroups = topFrame ? cleanGroups(scene, topFrame.pageGroups) : [];
  const groupInfos = (group: DeclaredGroup): Info[] => group.sources.flatMap(source => {
    const info = scene.byUrl.get(playlistIdentity(source.url));
    return info ? [info] : [];
  });
  // 1. What the page declares as its main entity, or as the file it names.
  const primary = pageGroups.filter(group => group.primary);
  for (const group of primary) probes.push(...groupProbes(scene, topFrame!, group, "page"));
  const declaredMain = ready(listing, primary.flatMap(groupInfos));
  if (declaredMain) return done(declaredMain);
  // 2. A page that declares exactly one video. Several unrelated ones are no hint.
  if (pageGroups.length === 1) {
    probes.push(...groupProbes(scene, topFrame!, pageGroups[0]!, "page"));
    const declared = ready(listing, groupInfos(pageGroups[0]!));
    if (declared) return done(declared);
  }
  // 3. What the page loaded: the best, nearest document first.
  const distance = (info: Info): number => info.origin === null ? 1 : info.origin.frameId === affinity ? 0
    : info.origin.frameId === 0 ? 1 : 2 + depthOf(scene, info.origin.frameId);
  const loaded = listed.filter(usable);
  if (loaded.length) {
    const nearest = Math.min(...loaded.map(distance));
    const main = best(loaded.filter(info => distance(info) === nearest))[0]!;
    return done({ state: "ready", main, candidates: withRenditions(main, listed) });
  }
  const protectedMedia = best(listed.filter(info => info.d.drm))[0];
  if (protectedMedia) return done({ state: "protected", main: protectedMedia, candidates: [protectedMedia] });
  const refused = best(listed.filter(info => !info.downloadable && !info.live))[0];
  if (refused) return done({ state: "unsupported", main: refused, candidates: [refused] });
  const live = best(listed.filter(info => info.live))[0];
  if (live) return done({ state: "live", main: live, candidates: [live] });
  if (pageState?.namedFile) return done({ state: "file-not-received", main: null, candidates: [] });
  if (adHoldsBack(scene, scene.elements.filter(waitsForSource))) return done({ state: "ad-playing", main: null, candidates: [] });
  if (scene.elements.some(element => element.fact.render !== "hidden" && element.fact.source.kind === "none")) {
    // A player without a source, on a page that asked for media and did not get it: that failure is the
    // answer, and starting playback is no advice. What only the page's data names says nothing yet.
    const asked = failures.asked();
    return done(asked ? { state: "failed", main: null, candidates: [], failure: asked } : { state: "not-loaded-yet", main: null, candidates: [] });
  }
  const failure = failures.current.find(item => !failures.quiet(item));
  return done(failure ? { state: "failed", main: null, candidates: [], failure } : { state: "no-media", main: null, candidates: [] });
}

/** Stage 5b: the answer about one media element, or "page" when the element leaves it to the page. */
function decideElement(scene: Scene, listing: Listing, failures: Failures, element: El, explicit: boolean): Decided<Decision | "page"> {
  const { listed } = listing;
  const probes: ProbeRequest[] = [];
  const done = (answer: Decision | "page"): Decided<Decision | "page"> => ({ answer, probes });
  const own = element.assigned.filter(info => info.listed);
  // 1. An element that used a key is protected. Another video never stands in for it.
  const elementDrm = own.find(info => info.d.source.kind === "media-element" && info.d.drm);
  if (element.fact.keyed || elementDrm) {
    return done({ state: "protected", main: elementDrm ?? null, candidates: elementDrm ? [elementDrm] : [], keySystem: element.fact.keyed?.keySystem ?? null });
  }
  const group = groupOf(scene, element);
  if (group) probes.push(...groupProbes(scene, element.frame, group, "element"));
  else if (element.sourceUrl) probes.push(...probeOf(scene, element.frame, { url: element.sourceUrl, groupId: "" }, null, "element"));
  // 2. Its own media can be saved.
  const mine = ready(listing, own);
  if (mine) return done(mine);
  if (own.length) {
    const protectedMedia = best(own.filter(info => info.d.drm))[0];
    if (protectedMedia) return done({ state: "protected", main: protectedMedia, candidates: [protectedMedia] });
    // 3. and 4. Its media is live, or of a kind that cannot be saved.
    const first = best(own)[0]!;
    return done({ state: own.every(info => info.live) ? "live" : "unsupported", main: first, candidates: [first] });
  }
  const fromDocument = (): Decision | null => {
    const free = orphans(listing, element.ref.frameId);
    if (free.length === 1) return { state: "ready", main: free[0]!, candidates: withRenditions(free[0]!, listed) };
    // Several streams and nothing that ties one to this player. Asked about this player, the answer is
    // that it cannot be told; asked about the page, the best of them is offered, as the page's and not as this player's.
    if (free.length > 1) {
      if (explicit) return { state: "ambiguous", main: null, candidates: [] };
      const choice = ready(listing, free);
      return choice ? { ...choice, pageChoice: true } : null;
    }
    return null;
  };
  // 5. The element plays an ad: the content is what its data declares, or what its document loaded.
  if (element.ad) {
    const nearest = nearestGroups(scene, element);
    for (const declared of nearest) probes.push(...groupProbes(scene, element.frame, declared, "element"));
    const content = ready(listing, nearest.flatMap(declared => groupUrls(declared).flatMap(url => scene.byUrl.get(url) ?? []))) ?? fromDocument();
    if (content) return done(content);
    // An ad that plays holds the video back, and the video follows it. An ad that is paused, has ended or never
    // started promises no video: asked about it, there is nothing to save, and asked about the page, the page answers.
    if (element.fact.playing) return done({ state: "ad-playing", main: null, candidates: [] });
    return done(explicit ? { state: "no-media", main: null, candidates: [] } : "page");
  }
  // 7. Its own source failed its check: that failure is the answer. An address its data names stands for
  // its source only once the player has played. Before that the page has given the player nothing, the
  // answer is that it has not loaded the video yet (8), and the failure is listed aside.
  const failed = (element.sourceUrl ? [element.sourceUrl] : group && element.fact.played ? groupUrls(group) : [])
    .map(url => scene.failureByUrl.get(url)).find(item => item !== undefined);
  if (failed) return done({ state: "failed", main: null, candidates: [], failure: failed });
  if (element.fact.source.kind === "stream") {
    return done(explicit ? { state: "no-media", main: null, candidates: [], streamSource: true } : "page");
  }
  // 8. The page has not given the player a source yet. While an ad plays in a video of its own next to it
  // or over it, in this document or in a frame laid over the player, the ad is what holds the source back.
  if (element.fact.source.kind === "none") {
    if (!explicit && listed.some(usable)) return done("page");
    if (adHoldsBack(scene, [element])) return done({ state: "ad-playing", main: null, candidates: [] });
    // Its document asked for media and did not get it (a server that refused, a network that blocked it):
    // that failure is the answer. Starting playback again cannot help.
    const asked = failures.asked(element.ref.frameId);
    return done(asked ? { state: "failed", main: null, candidates: [], failure: asked } : { state: "not-loaded-yet", main: null, candidates: [] });
  }
  // 9. A MediaSource player whose stream could not be told apart.
  if (element.fact.source.kind === "blob" || element.fact.source.kind === "media-source") {
    const found = fromDocument();
    // Nothing known is this player's video. A player that plays from memory may play a file a script fetched
    // whole: what its document fetched is checked, and a whole file among it is the document's stream next time.
    if (!found && element.fact.source.kind === "blob") probes.push(...fetchedProbes(scene, element));
    if (found || !explicit) return done(found ?? "page");
    // Asked about this player, with no stream of its document to offer. A stream its document asked for that
    // failed its check is the reason, the same one the page's own answer gives. Nothing ties a failure to a
    // MediaSource player but the document that made the request.
    const failure = failures.current.find(item => !failures.quiet(item)
      && (scene.media.origins[playlistIdentity(item.url)]?.frameId ?? 0) === element.ref.frameId);
    if (failure) return done({ state: "failed", main: null, candidates: [], failure });
    // A player that is playing has its stream already: starting playback is no advice. Nothing of it was received
    // in a form that can be saved. A player that is not playing may not have asked for its stream yet.
    return done({ state: element.fact.playing ? "no-media" : "not-loaded-yet", main: null, candidates: [] });
  }
  return done(explicit ? { state: "no-media", main: null, candidates: [] } : "page");
}

/** What the answer is about: an image, a media element, the stream a canvas draws, or the page. */
interface Target {
  readonly image: Selection["image"];
  readonly element: El | null;
  /** The user's pointer named the element. */
  readonly explicit: boolean;
  /** The stream a canvas under the pointer draws, when its video is no element of the document. */
  readonly drawn: Info | null;
  /** The pointer is on the picture the page declares as its video's still. */
  readonly still: boolean;
}

/** Stage 4: what the pointer is on, or the element that is decisively the page's first. */
function targetOf(scene: Scene, ranking: Ranking, listing: Listing, facts: TabFacts | null, usePointer: boolean): Target {
  const { ranked, listed } = listing;
  let image: Selection["image"] = null;
  let element: El | null = null;
  let explicit = false;
  let drawn: Info | null = null;
  let still = false;
  if (usePointer && facts) {
    const pointed = resolvePointer(facts, {
      isAdElement: ref => scene.elementByRef.get(refKey(ref))?.ad ?? false,
      ranked: frame => ranked.filter(item => item.ref.frameId === frame.frameId).map(item => item.ref),
    });
    if (pointed.kind === "image") image = { url: pointed.url, pageUrl: pointed.pageUrl, loaded: pointed.loaded };
    else if (pointed.kind === "element") { element = scene.elementByRef.get(refKey(pointed.ref)) ?? null; explicit = element !== null; }
    else if (pointed.kind === "page") still = pointed.still === true;
    else if (pointed.kind === "canvas") {
      // A video that was never attached shows only in what its document loaded: the one stream there that is no
      // element's is the canvas's, also with a control or a badge of the player above the canvas at the point.
      // With none or several, an image above the canvas is what the user points at (a badge over a chart or a
      // game); without one, the page's best video is the answer, as for any other spot.
      const unattached = listed.filter(info => usable(info) && info.element === null && (info.origin?.frameId ?? 0) === pointed.frameId);
      if (unattached.length === 1) drawn = unattached[0]!;
      else image = pointed.image;
    }
  }
  const first = ranked[0];
  const second = ranked[1];
  const decisive = first && (!second || compareKeys(ranking.key(first, elementLive(first)), ranking.key(second, elementLive(second))) !== 0) ? first : null;
  if (!element && !drawn) element = decisive;
  return { image, element, explicit, drawn, still };
}

/** Stage 5: the decision for the target, with the checks that could improve it. */
function decide(scene: Scene, listing: Listing, failures: Failures, target: Target): Decided<Decision> & { readonly later: readonly ProbeRequest[] } {
  if (target.image) return { answer: { state: "no-media", main: null, candidates: [] }, probes: [], later: [] };
  if (target.drawn) return { answer: { state: "ready", main: target.drawn, candidates: withRenditions(target.drawn, listing.listed) }, probes: [], later: [] };
  const pageAnswer = (page: Decided<Decision>, before: readonly ProbeRequest[]) => {
    // The user points at the still of the page's video and nothing of a video has reached the browser: a
    // player that makes its video element only on Play. The page has a video; it has not loaded it yet.
    const answer: Decision = target.still && page.answer.state === "no-media" ? { ...page.answer, state: "not-loaded-yet" } : page.answer;
    return withoutIdleRetries(scene, { answer, probes: [...before, ...page.probes] }, answer.main?.urls ?? []);
  };
  if (!target.element) return pageAnswer(pageFallback(scene, listing, failures, 0), []);
  const own = decideElement(scene, listing, failures, target.element, target.explicit);
  if (own.answer !== "page") {
    return withoutIdleRetries(scene, { answer: { ...own.answer, byElement: !own.answer.pageChoice }, probes: own.probes },
      target.element.sourceUrl ? [target.element.sourceUrl] : []);
  }
  return pageAnswer(pageFallback(scene, listing, failures, target.element.ref.frameId), own.probes);
}

/**
 * Stage 5c: the answer on a site that is read by a site reader alone. What the browser loads there is not
 * observed, so "nothing found" and "the page has not loaded the video yet" would both hide why, and starting
 * playback changes nothing. The answer names the reason instead. An image under the pointer, a stream made
 * inside the page, and every answer that offers or explains something stay as they are.
 */
function siteAnswer(decision: Decision, site: ManagedSite | null, target: Target, scene: Scene): Decision {
  if (!site || target.image || decision.streamSource) return decision;
  const nothing = decision.state === "no-media" || decision.state === "not-loaded-yet";
  if (site === "left-out") {
    const waiting = decision.state === "file-not-received" || decision.state === "ad-playing" || decision.state === "ambiguous";
    return nothing || waiting ? { state: "site-not-saved", main: null, candidates: [] } : decision;
  }
  // A page of the site without a player has no player data to speak of: there the plain answer stays.
  const player = scene.elements.some(element => element.fact.source.kind !== "stream");
  return nothing && player ? { state: "reader-found-nothing", main: null, candidates: [] } : decision;
}

/** Stage 6: the cards of the page's media, the main first, then by the order of their elements. */
function cardsOf(listing: Listing, main: Info | null): Card[] {
  const groups = new Map<string, Info[]>();
  for (const info of best(listing.listed)) {
    const d = info.d;
    const key = d.mediaGroup && d.capabilities.directDownload && !d.drm ? JSON.stringify([d.pageUrl, d.mediaGroup]) : d.id;
    groups.set(key, [...(groups.get(key) ?? []), info]);
  }
  const elementRank = new Map(listing.ranked.map((element, index) => [element, index]));
  const cardKey = (card: Info[]): number[] => {
    const element = card.map(info => info.element).find(item => item !== null) ?? null;
    const live = card.every(info => info.live);
    const eligibleAt = element && elementRank.has(element) ? elementRank.get(element)! : -1;
    const bucket = main && card.includes(main) ? 0 : live ? 4 : eligibleAt >= 0 ? 1 : element ? 3 : 2;
    return [bucket, Math.max(eligibleAt, 0)];
  };
  return [...groups.values()].map((card, index) => ({ card, key: cardKey(card), index }))
    .sort((a, b) => a.key[0]! - b.key[0]! || a.key[1]! - b.key[1]! || a.index - b.index).map(item => item.card)
    .map(card => ({
      ids: card.map(info => info.d.id),
      live: card.every(info => info.live),
      element: card.map(info => info.element).find(item => item !== null)?.ref ?? null,
    }));
}

export function select(input: SelectionInput): Selection {
  const scene = describeScene(input);
  const ranking = rankingOf(scene);
  associate(scene, ranking);
  const listing = list(scene, ranking, input.jobs);
  const failures = failuresOf(scene, input.failures);
  const target = targetOf(scene, ranking, listing, input.facts, input.usePointer);
  const { answer, probes, later } = decide(scene, listing, failures, target);
  const decision = siteAnswer(answer, input.site ?? null, target, scene);
  const { image, explicit, drawn } = target;
  const element = target.element;
  const main = decision.main;
  const mainElement = decision.byElement ? element : null;
  // A build that leaves the site's reader out makes no check of what such a page declares or its players hold.
  const unchecked = input.site === "left-out";
  const toProbe = collectProbes(unchecked ? [] : probes);

  // The page's name for the main, when the server gave it none. The name is the file's only when the file's own
  // bytes are of the kind the name says: a page that names "Movie.mkv" and plays an MP4 preview of it has not
  // sent Movie.mkv, and the preview keeps its own name. Nothing else ties a file to the name a page shows.
  const pageState = scene.frames.find(frame => frame.top)?.page ?? null;
  const named = pageState?.namedFile ?? null;
  const directFile = (info: Info): boolean => info.d.source.kind === "direct-url" && info.d.capabilities.directDownload;
  const canBeNamed = (info: Info): boolean => named !== null && directFile(info) && nameFitsContainer(named, info.d.container);
  const topDirect = listing.listed.filter(info => directFile(info) && (info.origin?.frameId ?? 0) === 0);
  const mainName = main && named && topDirect.length === 1 && topDirect[0] === main && !serverNamed(main.d) && canBeNamed(main) ? named : null;
  // Nothing listed can be the file the page names: it has not reached the browser, whatever else has.
  const namedPending = named !== null && listing.listed.length > 0 && !listing.listed.some(canBeNamed) ? named : null;

  const previews: Record<string, PreviewView> = {};
  for (const info of listing.listed) {
    const shown = info.element;
    if (!shown) continue;
    previews[info.d.id] = { thumbnail: shown.fact.thumbnail ?? null, width: shown.fact.width, height: shown.fact.height,
      duration: info.duration ?? shown.fact.duration };
  }

  // Other players' own sources, for the popup's list, and the failed sources a ready answer does not wait for.
  const listProbe = collectProbes(unchecked ? [] : [...listing.ranked.flatMap(other =>
    other === element || !other.sourceUrl || other.ad || toProbe.has(other.sourceUrl) ? []
      : probeOf(scene, other.frame, { url: other.sourceUrl, groupId: "" }, null, "element")), ...later]);

  const authoritative = decision.failure ?? null;
  return {
    state: decision.state,
    main: main?.d.id ?? null,
    candidates: decision.candidates.map(info => info.d.id),
    element: mainElement?.ref ?? null,
    reason: image ? null : explicit || drawn ? "pointer" : !element ? (main ? "page" : null) : element.fact.pip ? "picture-in-picture"
      : element.fact.fullscreen ? "fullscreen" : element.area > 0 ? (element.fact.playing ? "playing" : "visible") : "offscreen",
    mainName,
    namedPending,
    failure: authoritative,
    keySystem: decision.keySystem ?? null,
    streamSource: decision.streamSource === true,
    targetPlaying: !image && element !== null && element.fact.playing,
    image,
    toProbe: [...toProbe.values()],
    listProbe: [...listProbe.values()],
    cards: cardsOf(listing, main),
    ads: best(listing.ads).map(info => ({ ids: [info.d.id], live: info.live, element: null })),
    previews,
    shownFailures: failures.current.filter(failure => failure !== authoritative && !failures.quiet(failure)),
  };
}

/** The selection as the popup renders it. */
export function selectionView(selection: Selection): SelectionView {
  return {
    state: selection.state,
    mainId: selection.main,
    elementMain: selection.element !== null && selection.main !== null,
    mainName: selection.mainName,
    ...(selection.namedPending ? { namedPending: selection.namedPending } : {}),
    cards: selection.cards.map(card => ({ ids: card.ids, live: card.live })),
    ads: selection.ads.map(card => ({ ids: card.ids, live: card.live })),
  };
}
