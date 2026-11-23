import { parseFrameFacts, parsePageFileState, type BackgroundToContentMessage, type FileDownloadOffer } from "../types/messages";
import type { CollectedFrame, TabFacts } from "../types/page-facts";
import type { FrameTracker } from "./frames";
import type { TabMediaStore } from "./tab-media";

export interface FactsCollectorDeps {
  readonly frames: Pick<FrameTracker, "frames">;
  /** Resolves null at once for a frame without a reachable content script. */
  readonly send: (tabId: number, target: { frameId: number; documentId?: string }, msg: BackgroundToContentMessage) => Promise<unknown>;
  readonly store: Pick<TabMediaStore, "setFacts">;
}

/**
 * Ask every frame of the tab for its facts, in parallel. A frame answers
 * synchronously or not at all, so there is nothing to wait out.
 *
 * Who a frame is, is the browser's answer, never the frame's own: its id,
 * its document, its address and whether it is the tab's top frame come from
 * the frame tracker. A frame's address becomes the Referer of the checks the
 * user asks for, so a frame must not be able to name another site's.
 */
/**
 * Stored facts as far as they describe the routes the tab shows now. A frame
 * that changed its route since its facts were read (a single-page site that
 * moved on to the next video) is left out: what its players held then says
 * nothing about what they hold now, and would keep the last route's video
 * listed and counted. The facts of a look that is under way are never
 * passed through here: they are the page as the user's action found it.
 */
export function factsOfCurrentRoutes(facts: TabFacts | null, generation: (frameId: number) => number): TabFacts | null {
  if (!facts) return null;
  const current = facts.frames.filter(frame => frame.generation === undefined || frame.generation >= generation(frame.frameId));
  return current.length === facts.frames.length ? facts : { reachable: facts.reachable, frames: current };
}

export function createFactsCollector(deps: FactsCollectorDeps) {
  return {
    async collect(tabId: number, options: { pointer: boolean; thumbnails: boolean }): Promise<TabFacts> {
      const frames = await deps.frames.frames(tabId);
      const message: BackgroundToContentMessage = { type: "collect-facts", pointer: options.pointer, thumbnails: options.thumbnails };
      const replies = await Promise.all(frames.map(async frame => {
        const reply = await deps.send(tabId, { frameId: frame.frameId, ...(frame.documentId ? { documentId: frame.documentId } : {}) }, message)
          .catch(() => null);
        const facts = parseFrameFacts(reply);
        const collected: CollectedFrame | null = facts ? { ...facts, url: frame.url, top: frame.frameId === 0, frameId: frame.frameId,
          documentId: frame.documentId, generation: frame.generation } : null;
        return collected;
      }));
      const collected = replies.filter((frame): frame is CollectedFrame => frame !== null);
      const facts: TabFacts = { reachable: collected.some(frame => frame.frameId === 0), frames: collected };
      deps.store.setFacts(tabId, facts);
      return facts;
    },
    /**
     * The file the tab's top page offers right now, asked afresh: the stored facts can be older than the
     * save that asks. An answer that is not a page's file state names no file.
     */
    async offeredFile(tabId: number, pageUrl: string): Promise<FileDownloadOffer | undefined> {
      const message: BackgroundToContentMessage = { type: "file-save-state", pageUrl };
      return parsePageFileState(await deps.send(tabId, { frameId: 0 }, message).catch(() => null))?.fileDownload;
    },
  };
}

export interface RouteFollowerDeps {
  /** Whether the tab's facts were read before: a tab the user has looked at. */
  readonly looked: (tabId: number) => boolean;
  /** Whether a popup shows the tab now. */
  readonly shown: (tabId: number) => boolean;
  /** One read of every frame's facts, without checks or thumbnails. */
  readonly read: (tabId: number) => Promise<unknown>;
  /** What the tab lists may have changed: the toolbar count and the open popups follow. */
  readonly changed: (tabId: number) => void;
}

/**
 * What follows a route change inside a page (history.pushState or
 * replaceState, the Navigation API), where no new document says that the
 * page moved on. Facts read on the route before are already left out of
 * what the tab lists (factsOfCurrentRoutes), so the change is announced, and
 * the count and the list follow from what the browser received.
 *
 * The page is read again only while a popup shows the tab: that popup shows
 * the page as it is now. With no popup open nothing is read. A page may
 * change its address every second while it plays (a player that keeps the
 * current time in the address, a feed that scrolls), and a read of every
 * frame for each change would never end; the user's next look at the page
 * reads the new route. A burst of route changes ends in one more read.
 */
export function createRouteFollower(deps: RouteFollowerDeps): (tabId: number) => void {
  /** Tabs being read again; true when another route change arrived meanwhile. */
  const reading = new Map<number, boolean>();
  async function readAgain(tabId: number): Promise<void> {
    if (reading.has(tabId)) { reading.set(tabId, true); return; }
    try {
      do {
        reading.set(tabId, false);
        await deps.read(tabId).catch(() => null);
        // The popup closed while the page was read: the next look reads the route the page is on then.
      } while (reading.get(tabId) && deps.shown(tabId));
    } finally {
      reading.delete(tabId);
      deps.changed(tabId);
    }
  }
  return tabId => {
    if (deps.looked(tabId) && deps.shown(tabId)) void readAgain(tabId);
    else deps.changed(tabId);
  };
}
