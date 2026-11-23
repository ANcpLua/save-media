// The tab's frame tree and each frame's document, from the browser's own
// navigation events. It survives service worker restarts because the browser
// answers getAllFrames at any time.
import type { TabMediaStore } from "./tab-media";
import { REMOVED_FRAME } from "../util/tab-media-state";

export interface FrameRecord {
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly documentId: string | null;
  readonly url: string;
  readonly generation: number;
}

interface NavigationDetails {
  readonly tabId: number;
  readonly frameId: number;
  readonly url: string;
  readonly documentId?: string;
  readonly documentLifecycle?: string;
  readonly parentFrameId?: number;
}

interface FrameDetails {
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly url: string;
  readonly documentId?: string;
  readonly documentLifecycle?: string;
}

export interface NavigationApi {
  getAllFrames(details: { tabId: number }): Promise<FrameDetails[] | null | undefined>;
  onCommitted: { addListener(listener: (details: NavigationDetails) => void): void };
  onHistoryStateUpdated: { addListener(listener: (details: NavigationDetails) => void): void };
  /** A navigation that did not end in a document of the site. `error` is the browser's code for why. */
  onErrorOccurred?: { addListener(listener: (details: NavigationDetails & { readonly error: string }) => void): void };
}

/**
 * A navigation the browser dropped while the page before it stays: the user
 * stopped it, another navigation replaced it, or it became a download.
 */
const DROPPED = new Set(["net::ERR_ABORTED", "NS_BINDING_ABORTED"]);

export interface FrameEvents {
  /** The tab shows a new top document: a load, a reload, or a restore from the back-forward cache. */
  topDocument(tabId: number, url: string): void;
  /** A subframe shows a new document. */
  frameDocument(tabId: number, frameId: number): void;
  /** A frame changed its route without a new document. */
  navigated(tabId: number, frameId: number): void;
}

export type FrameTracker = ReturnType<typeof createFrameTracker>;

function active(details: { documentLifecycle?: string }): boolean {
  return details.documentLifecycle === undefined || details.documentLifecycle === "active";
}

/** The part of an address that makes a route: everything but the fragment. */
function route(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

export function createFrameTracker(api: NavigationApi | undefined, store: TabMediaStore, on: FrameEvents) {
  function record(tabId: number, frameId: number, documentId: string | null, url: string, parent?: number): void {
    const frames = store.tab(tabId).frames;
    const known = frames[frameId];
    const above = parent ?? known?.parent;
    frames[frameId] = { documentId, url, generation: known && known.documentId === documentId ? known.generation : 0,
      ...(above === undefined ? {} : { parent: above }) };
    store.changed(tabId, "media");
  }

  api?.onCommitted.addListener(details => {
    if (details.tabId < 0 || !active(details)) return;
    const documentId = details.documentId ?? null;
    if (details.frameId === 0) {
      const state = store.tab(details.tabId);
      // A navigation that becomes a download commits nothing and keeps the state.
      const changed = documentId === null || state.topDocument !== documentId;
      if (changed) store.leaveTopDocument(details.tabId);
      state.topDocument = documentId;
      if (changed) state.frames = {};
      record(details.tabId, 0, documentId, details.url, -1);
      if (changed) on.topDocument(details.tabId, details.url);
      return;
    }
    record(details.tabId, details.frameId, documentId, details.url, details.parentFrameId);
    on.frameDocument(details.tabId, details.frameId);
  });

  // A top-level navigation that failed: the tab shows the browser's own error page, which no content
  // script runs in. The document before it is gone, and what it had loaded with it. The next document
  // that commits clears the mark, because the tab's state is reset then.
  api?.onErrorOccurred?.addListener(details => {
    if (details.tabId < 0 || details.frameId !== 0 || !active(details) || DROPPED.has(details.error)) return;
    const state = store.tab(details.tabId);
    store.leaveTopDocument(details.tabId);
    state.topDocument = details.documentId ?? null;
    state.frames = {};
    record(details.tabId, 0, details.documentId ?? null, details.url, -1);
    on.topDocument(details.tabId, details.url);
    store.tab(details.tabId).loadFailed = true;
    store.changed(details.tabId, "media");
  });

  api?.onHistoryStateUpdated.addListener(details => {
    if (details.tabId < 0 || !active(details)) return;
    const frames = store.tab(details.tabId).frames;
    const known = frames[details.frameId];
    if (!known) {
      record(details.tabId, details.frameId, details.documentId ?? null, details.url, details.parentFrameId);
      return;
    }
    // Only the fragment changed: the same route.
    if (route(known.url) === route(details.url)) { known.url = details.url; store.changed(details.tabId, "media"); return; }
    frames[details.frameId] = { ...known, url: details.url, generation: known.generation + 1 };
    store.changed(details.tabId, "media");
    on.navigated(details.tabId, details.frameId);
  });

  return {
    /** The tab's active frames, with each frame's route generation. */
    async frames(tabId: number): Promise<readonly FrameRecord[]> {
      const all = await api?.getAllFrames({ tabId }).catch(() => null);
      const listed = (all ?? []).filter(active);
      if (!listed.length) return [{ frameId: 0, parentFrameId: -1, documentId: store.tab(tabId).frames[0]?.documentId ?? null,
        url: store.tab(tabId).frames[0]?.url ?? "", generation: store.tab(tabId).frames[0]?.generation ?? 0 }];
      const state = store.tab(tabId);
      // A frame the browser no longer lists was removed from the page. No
      // event reports that, so it is noticed here: what the frame loaded is
      // gone with it, as when a frame shows a new document.
      const live = new Set(listed.map(frame => frame.frameId));
      for (const [id, known] of Object.entries(state.frames)) {
        const frameId = Number(id);
        if (frameId === 0 || live.has(frameId) || known.documentId === REMOVED_FRAME) continue;
        state.frames[frameId] = { ...known, documentId: REMOVED_FRAME };
        store.changed(tabId, "media");
        on.frameDocument(tabId, frameId);
      }
      return listed.map(frame => {
        const documentId = frame.documentId ?? null;
        const known = state.frames[frame.frameId];
        if (!known || known.documentId !== documentId || known.parent !== frame.parentFrameId) {
          record(tabId, frame.frameId, documentId, frame.url, frame.parentFrameId);
        }
        if (frame.frameId === 0 && state.topDocument === null) { state.topDocument = documentId; store.changed(tabId, "media"); }
        return { frameId: frame.frameId, parentFrameId: frame.parentFrameId, documentId, url: frame.url,
          generation: state.frames[frame.frameId]?.generation ?? 0 };
      });
    },
    generation(tabId: number, frameId: number): number {
      return store.has(tabId) ? store.tab(tabId).frames[frameId]?.generation ?? 0 : 0;
    },
    frameUrl(tabId: number, frameId: number): string | undefined {
      return store.has(tabId) ? store.tab(tabId).frames[frameId]?.url || undefined : undefined;
    },
    /** The tab's last top-level navigation failed: it shows the browser's error page. */
    loadFailed(tabId: number): boolean {
      return store.has(tabId) && store.tab(tabId).loadFailed;
    },
    documentId(tabId: number, frameId: number): string | null {
      return store.has(tabId) ? store.tab(tabId).frames[frameId]?.documentId ?? null : null;
    },
    /**
     * Whether a message's document is the one the frame shows now. A document
     * that was replaced can still deliver a late message: what it reports is
     * about a page that is gone. Unknown frames, after a service worker
     * restart, count as current.
     */
    isCurrent(tabId: number, frameId: number, documentId: string | null): boolean {
      if (!store.has(tabId) || documentId === null) return true;
      const state = store.tab(tabId);
      const known = frameId === 0 ? state.topDocument ?? state.frames[0]?.documentId ?? null : state.frames[frameId]?.documentId ?? null;
      return known === null || known === documentId;
    },
    /**
     * A frame announced its document. For the top frame, a document
     * other than the recorded one is a new top document that committed nothing
     * (a prerendered page that was activated). With nothing recorded, after a
     * service worker restart, the document is adopted without a reset.
     */
    noteSender(tabId: number, frameId: number, documentId: string | null, url: string): void {
      const state = store.tab(tabId);
      if (frameId === 0 && documentId !== null && state.topDocument !== null && state.topDocument !== documentId) {
        store.leaveTopDocument(tabId);
        state.topDocument = documentId;
        state.frames = {};
        record(tabId, 0, documentId, url, -1);
        on.topDocument(tabId, url);
        return;
      }
      if (frameId === 0 && state.topDocument === null) { state.topDocument = documentId; store.changed(tabId, "media"); }
      const known = state.frames[frameId];
      if (!known || known.documentId !== documentId) record(tabId, frameId, documentId, url);
    },
  };
}
