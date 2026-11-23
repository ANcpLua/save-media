// What savemedia knows about a tab's media besides the descriptors: where
// each one came from, which stream the page is requesting now, which
// addresses are ads, and the last facts the frames reported. Plain data, so
// it can be stored as it is. Nothing here is a decision: the selector reads
// these facts on every call.
import type { Presentation, StreamDescriptor, StreamId } from "@savemedia/core";
import type { AdVia } from "../types/messages";
import type { TabFacts } from "../types/page-facts";
import { playlistIdentity } from "../util/media-url";
import { webOrigin } from "../util/address-space";
import { elementDrmKey, emptyTabMediaState, FETCHED_PER_LOOK, inFrameTree, urlsOf, type ElementDrm, type Fetched, type Origin, type Received, type TabMediaState } from "../util/tab-media-state";

export { elementDrmKey, urlsOf } from "../util/tab-media-state";
export type { Activity, ElementDrm, Origin, TabMediaState, Via } from "../util/tab-media-state";

const LIMITS = { origins: 2000, owners: 5000, activity: 200, ads: 500, assetLists: 50, timelines: 200, elementDrm: 100, received: 2000,
  localOrigins: 64, fetched: 64 } as const;
/** The most segment addresses of one stream that are indexed: enough to see the page still requesting it. */
const MAX_INDEXED_PARTS = 1000;
/** Top documents whose received addresses are kept for a restore from the back-forward cache. */
const MAX_EARLIER_DOCUMENTS = 4;

/**
 * The order of a record's keys, oldest first, kept beside the plain record
 * so that an insert never lists every key. A refreshed key gets a new entry;
 * its older entries are skipped when they reach the front.
 */
interface KeyOrder { queue: [key: string, stamp: number][]; head: number; readonly stamps: Map<string, number>; next: number }
const orders = new WeakMap<object, KeyOrder>();

function orderOf(record: Record<string, unknown>): KeyOrder {
  let order = orders.get(record);
  if (!order) {
    // A record that was stored and read back: its own key order is the order of insertion.
    const keys = Object.keys(record);
    order = { queue: keys.map((key, index) => [key, index]), head: 0, stamps: new Map(keys.map((key, index) => [key, index])), next: keys.length };
    orders.set(record, order);
  }
  return order;
}

/** Insert or refresh a key, dropping the oldest entries above the limit. Constant work per call on average. */
export function put<T>(record: Record<string, T>, key: string, value: T, limit: number): void {
  const order = orderOf(record);
  const stamp = order.next++;
  order.stamps.set(key, stamp);
  order.queue.push([key, stamp]);
  record[key] = value;
  while (order.stamps.size > limit) {
    const [oldest, at] = order.queue[order.head++]!;
    if (order.stamps.get(oldest) !== at) continue;
    order.stamps.delete(oldest);
    delete record[oldest];
  }
  // Entries of refreshed and dropped keys are cleared out once they outnumber the live ones.
  if (order.queue.length - order.head > 2 * order.stamps.size + 64 || order.head > 4096) {
    order.queue = order.queue.slice(order.head).filter(([name, at]) => order.stamps.get(name) === at);
    order.head = 0;
  }
}

/** Remove a key that put() inserted, so the record's order no longer counts it. */
function drop(record: Record<string, unknown>, key: string): void {
  orders.get(record)?.stamps.delete(key);
  delete record[key];
}

/** The init section and segment addresses of a stream, thinned evenly to at most `limit`. */
function sampledParts(descriptor: StreamDescriptor, limit: number): string[] {
  const lists: (readonly string[])[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const variant of [...descriptor.variants, ...(descriptor.audioRenditions ?? [])]) {
    const ref = variant.segmentRef;
    const init = ref.kind === "hls-segments" ? ref.initSegmentUrl : ref.kind === "dash-segments" ? ref.initUrl : null;
    const urls = ref.kind === "hls-segments" ? ref.segmentUrls : ref.kind === "dash-segments" ? ref.mediaUrls : [];
    if (init) parts.push(init);
    lists.push(urls);
    total += urls.length;
  }
  // Every n-th segment: the page's requests keep reaching an indexed one as it plays.
  const step = Math.max(1, Math.ceil(total / Math.max(1, limit - parts.length)));
  for (const urls of lists) for (let index = 0; index < urls.length; index += step) parts.push(urls[index]!);
  return parts;
}

export type TabMediaStore = ReturnType<typeof createTabMediaStore>;

/** The stored parts of a tab's state: each is written as a whole when it changed. */
export type StoredPart = "media" | "origins" | "received" | "activity" | "facts";
export const STORED_PARTS: readonly StoredPart[] = ["media", "origins", "received", "activity", "facts"];

export interface TabMediaImport {
  readonly media?: (Pick<TabMediaState, "topDocument" | "frames" | "ads" | "assetLists" | "timelines" | "elementDrm">
    & Partial<Pick<TabMediaState, "loadFailed">>) | undefined;
  readonly origins?: TabMediaState["origins"] | undefined;
  readonly received?: (Pick<TabMediaState, "received" | "earlier"> & Partial<Pick<TabMediaState, "localOrigins" | "fetched">>) | undefined;
  readonly activity?: TabMediaState["activity"] | undefined;
  readonly facts?: TabFacts | undefined;
}

/**
 * `onChange` is told which stored part of a tab changed. Owners are not
 * stored: they are indexed again from the descriptors. Activity and the last
 * facts are, because what a tab lists is decided from them: a restarted
 * worker lists what the worker before it listed.
 */
export function createTabMediaStore(now: () => number = Date.now, onChange?: (tabId: number, part: StoredPart) => void) {
  const tabs = new Map<number, TabMediaState>();
  /** Per tab, the stream the page requested last. A further request for the same stream on the same route changes no decision. */
  const lastActive = new Map<number, string>();

  function tab(tabId: number): TabMediaState {
    let state = tabs.get(tabId);
    if (!state) {
      state = emptyTabMediaState();
      tabs.set(tabId, state);
    }
    return state;
  }

  return {
    tab,
    has: (tabId: number): boolean => tabs.has(tabId),
    /** The frame record or the top document changed. The frame tracker writes them in place and says so here. */
    changed: (tabId: number, part: StoredPart): void => onChange?.(tabId, part),
    /** A tab's stored parts, back in memory after a worker restart. */
    importTab(tabId: number, stored: TabMediaImport): void {
      const state = tab(tabId);
      if (stored.media) Object.assign(state, stored.media, { loadFailed: stored.media.loadFailed === true });
      if (stored.origins) state.origins = stored.origins;
      if (stored.received) {
        state.received = stored.received.received;
        state.earlier = stored.received.earlier;
        state.localOrigins = stored.received.localOrigins ?? {};
        state.fetched = stored.received.fetched ?? {};
      }
      if (stored.activity) state.activity = stored.activity;
      if (stored.facts) state.facts = stored.facts;
    },
    tabIds: (): number[] => [...tabs.keys()],
    /**
     * The tab is about to show another top document. What the leaving
     * document received is kept under its id: a restore from the
     * back-forward cache shows the same document again without new requests.
     */
    leaveTopDocument(tabId: number): void {
      const state = tabs.get(tabId);
      if (!state?.topDocument || (!Object.keys(state.received).length && !Object.keys(state.localOrigins).length && !Object.keys(state.fetched).length)) return;
      state.earlier = [...state.earlier.filter(item => item.documentId !== state.topDocument),
        { documentId: state.topDocument, received: state.received, localOrigins: state.localOrigins, fetched: state.fetched }].slice(-MAX_EARLIER_DOCUMENTS);
      onChange?.(tabId, "received");
    },
    /** A new top document: everything about the old one goes, the frame record stays with the caller. */
    reset(tabId: number): void {
      const previous = tabs.get(tabId);
      const next = emptyTabMediaState();
      if (previous) {
        next.topDocument = previous.topDocument;
        next.frames = previous.frames;
        // The document was shown before: it is the document that received these.
        const restored = previous.earlier.find(item => item.documentId === next.topDocument);
        if (restored) { next.received = restored.received; next.localOrigins = restored.localOrigins ?? {}; next.fetched = restored.fetched ?? {}; }
        next.earlier = previous.earlier.filter(item => item !== restored);
      }
      tabs.set(tabId, next);
      lastActive.delete(tabId);
      for (const part of STORED_PARTS) onChange?.(tabId, part);
    },
    forget(tabId: number): void { tabs.delete(tabId); lastActive.delete(tabId); },

    /** Merge: the union of how it was seen, the latest frame and document, the highest generation. */
    recordOrigin(tabId: number, url: string, origin: Origin): void {
      const state = tab(tabId);
      const key = playlistIdentity(url);
      const known = state.origins[key];
      put(state.origins, key, known ? {
        frameId: origin.frameId,
        documentId: origin.documentId ?? known.documentId,
        generation: Math.max(known.generation, origin.generation),
        via: [...new Set([...known.via, ...origin.via])],
        scope: origin.scope ?? known.scope,
        // The first check that found the media: a frame that names the address later does not change what a save sends.
        ...(known.referrer ?? origin.referrer ? { referrer: known.referrer ?? origin.referrer } : {}),
      } : origin, LIMITS.origins);
      onChange?.(tabId, "origins");
    },
    originOf(tabId: number, urls: readonly string[]): Origin | null {
      const state = tabs.get(tabId);
      let best: Origin | null = null;
      for (const url of urls) {
        const origin = state?.origins[playlistIdentity(url)];
        if (origin && (!best || origin.generation > best.generation)) best = origin;
      }
      return best;
    },

    /**
     * Which stream an address belongs to. The stream's own addresses are all
     * indexed; of a long stream's segments only an even sample, so one
     * stream neither costs time in proportion to its length nor pushes the
     * tab's other streams out.
     */
    indexOwners(tabId: number, descriptor: StreamDescriptor): void {
      const state = tab(tabId);
      const [owner, ...own] = urlsOf(descriptor);
      if (!owner) return;
      for (const url of [owner, ...own]) put(state.owners, url, owner, LIMITS.owners);
      for (const url of sampledParts(descriptor, MAX_INDEXED_PARTS)) put(state.owners, playlistIdentity(url), owner, LIMITS.owners);
    },
    /** A request the page made: note it when it belongs to a known stream. */
    touch(tabId: number, url: string, frameId: number, generation: number): boolean {
      const state = tabs.get(tabId);
      const owner = state?.owners[playlistIdentity(url)];
      if (!state || !owner) return false;
      const known = Object.hasOwn(state.activity, owner) ? state.activity[owner]! : null;
      put(state.activity, owner, { at: now(), frameId, generation }, LIMITS.activity);
      // Stored when the answer of a selection can change: another stream is the latest now, or the frame or route differs.
      // The time alone orders streams, and the order is the same after the next request of the same stream.
      if (!known || known.frameId !== frameId || known.generation !== generation || lastActive.get(tabId) !== owner) {
        lastActive.set(tabId, owner);
        onChange?.(tabId, "activity");
      }
      return true;
    },

    /**
     * Mark addresses a frame's ad response named. Returns the addresses that
     * were not marked before. A frame speaks for its own media and for the
     * frames inside it. About another frame's media it is heard only before
     * the browser received that address: an ad's schedule comes before its
     * media, and a frame cannot hide what another frame already loaded.
     */
    markAds(tabId: number, urls: readonly string[], via: AdVia, frameId = 0): string[] {
      const state = tab(tabId);
      const added: string[] = [];
      for (const url of urls) {
        const key = playlistIdentity(url);
        if (state.ads[key]) continue;
        const fetchedBy = Object.hasOwn(state.fetched, key) ? state.fetched[key]!.frameId : undefined;
        const loadedBy = state.received[key]?.frameId ?? fetchedBy ?? state.origins[key]?.frameId;
        if (loadedBy !== undefined && !inFrameTree(state.frames, loadedBy, frameId)) continue;
        put(state.ads, key, via, LIMITS.ads);
        added.push(key);
      }
      if (added.length) onChange?.(tabId, "media");
      return added;
    },
    isAd(tabId: number, url: string): boolean {
      return tabs.get(tabId)?.ads[playlistIdentity(url)] !== undefined;
    },
    noteAssetLists(tabId: number, urls: readonly string[]): void {
      const state = tab(tabId);
      let added = false;
      for (const url of urls) if (!state.assetLists.includes(url) && state.assetLists.length < LIMITS.assetLists) { state.assetLists.push(url); added = true; }
      if (added) onChange?.(tabId, "media");
    },

    recordTimeline(tabId: number, url: string, presentation: Presentation): void {
      put(tab(tabId).timelines, playlistIdentity(url), presentation, LIMITS.timelines);
      onChange?.(tabId, "media");
    },

    /** The descriptor id of a protected element. The same element always gets the same id. */
    upsertElementDrm(tabId: number, frameId: number, documentId: string | null, key: string | null, keySystem: string | null, elementSrc: string | null): ElementDrm {
      const state = tab(tabId);
      const name = elementDrmKey(frameId, documentId, key);
      const known = state.elementDrm[name];
      const entry: ElementDrm = { id: `protected:${tabId}:${name}` as StreamId, keySystem: keySystem ?? known?.keySystem ?? null,
        elementSrc: elementSrc ?? known?.elementSrc ?? null, frameId };
      put(state.elementDrm, name, entry, LIMITS.elementDrm);
      if (!known || known.keySystem !== entry.keySystem || known.elementSrc !== entry.elementSrc) onChange?.(tabId, "media");
      return entry;
    },

    noteReceived(tabId: number, url: string, ip: string | null, frameId = 0): void {
      const key = playlistIdentity(url);
      const state = tab(tabId);
      const known = Object.hasOwn(state.received, key) ? state.received[key]! : null;
      put(state.received, key, { ip, frameId }, LIMITS.received);
      if (!known || known.ip !== ip || known.frameId !== frameId) onChange?.(tabId, "received");
    },
    /**
     * The browser itself received an answer from this address's origin at an address inside the user's
     * network. The caller has read that from the browser's own request event; nothing savemedia requested is noted.
     * Returns whether the origin is new for the tab's document.
     */
    noteLocalOrigin(tabId: number, url: string): boolean {
      const origin = webOrigin(url);
      if (!origin) return false;
      const state = tab(tabId);
      const known = Object.hasOwn(state.localOrigins, origin);
      put(state.localOrigins, origin, true, LIMITS.localOrigins);
      if (!known) onChange?.(tabId, "received");
      return !known;
    },
    /** Whether the browser itself received an answer from this address's origin at a local address, in this tab's document. */
    localOrigin(tabId: number, url: string): boolean {
      const origin = webOrigin(url);
      const state = tabs.get(tabId);
      return !!origin && !!state && Object.hasOwn(state.localOrigins, origin);
    },
    /** Those origins, as a save takes them along. */
    localOrigins(tabId: number): string[] {
      return Object.keys(tabs.get(tabId)?.localOrigins ?? {});
    },
    /**
     * A document's own script fetched a video answer whole. Noted, not checked: the user's next look at
     * the page checks it when a player of that document plays from memory and nothing else is its video.
     * `ip` is the address of the server that answered, kept with the note for that check.
     *
     * A player that is fed piece by piece adds a note per piece, so a note is not a change to store each
     * time: the tab's first notes are stored, as many as one look asks about (FETCHED_PER_LOOK), which is
     * what a page that fetched a file or a few has. Notes past that are kept in memory, and are stored
     * with the tab's next stored change. A worker that restarts in between knows the stored ones.
     */
    noteFetched(tabId: number, url: string, frameId: number, documentId: string | null, ip: string | null = null): void {
      const key = playlistIdentity(url);
      const state = tab(tabId);
      const known = Object.hasOwn(state.fetched, key) ? state.fetched[key]! : null;
      put<Fetched>(state.fetched, key, { frameId, documentId, ip }, LIMITS.fetched);
      const changed = !known || known.frameId !== frameId || known.documentId !== documentId || known.ip !== ip;
      if (changed && Object.keys(state.fetched).length <= FETCHED_PER_LOOK) onChange?.(tabId, "received");
    },
    /** A noted answer a script fetched whole: who asked, and which server answered. */
    fetched(tabId: number, url: string): Fetched | null {
      const state = tabs.get(tabId);
      const key = playlistIdentity(url);
      return state && Object.hasOwn(state.fetched, key) ? state.fetched[key]! : null;
    },
    /** The check found a part of a stream, not a whole file: it is not asked about again. */
    forgetFetched(tabId: number, url: string): void {
      const state = tabs.get(tabId);
      const key = playlistIdentity(url);
      if (!state || !Object.hasOwn(state.fetched, key)) return;
      drop(state.fetched, key);
      onChange?.(tabId, "received");
    },
    /** Whether the browser itself received this address in this tab, from which server address and in which frame. */
    received(tabId: number, url: string): Received | null {
      const state = tabs.get(tabId);
      const key = playlistIdentity(url);
      return state && Object.hasOwn(state.received, key) ? state.received[key]! : null;
    },

    setFacts(tabId: number, facts: TabFacts): void {
      tab(tabId).facts = { reachable: facts.reachable, frames: facts.frames.map(frame => ({ ...frame,
        elements: frame.elements.map(({ thumbnail: _thumbnail, ...element }) => element) })) };
      onChange?.(tabId, "facts");
    },
  };
}
