// What a message from a page's bridge may make savemedia request. A page can
// make its bridge say anything, so every decision here is taken from the
// message's sender and from what the browser itself did, never from what the
// message claims. Pure: the service worker's listener only carries it out.
import type { CaptureMessage, CaptureOptions } from "./capture";
import { MAIN_BRIDGE_TAG } from "../types/messages";
import { unobservedLocalTarget, webPage, type ObservedLocal } from "../util/address-space";
import { inFrameTree, type Received, type TabMediaState } from "../util/tab-media-state";
import { isExtractorManagedHost } from "./network-capture";

export interface BridgeSender {
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
  readonly tabUrl?: string | undefined;
  readonly frameId: number;
  readonly documentId: string | null;
  readonly documentLifecycle?: string | undefined;
}

export interface RoutingContext {
  /** The address of the tab's top document, as the browser reported it. */
  readonly topUrl: string | undefined;
  /** Whether the document is the one its frame shows now. */
  readonly isCurrent: (frameId: number, documentId: string | null) => boolean;
  /** Whether the browser itself received this address in this tab. */
  readonly received: (url: string) => Received | null;
  /** Whether the browser itself was answered from this address's origin at a local address, in this tab. */
  readonly observedLocal?: ObservedLocal;
}

export interface CaptureRoute { readonly message: CaptureMessage; readonly options: CaptureOptions }

/** A document that is no longer shown, or was replaced, reports about a page that is gone. */
export function fromShownDocument(sender: BridgeSender, context: Pick<RoutingContext, "isCurrent">): boolean {
  if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active") return false;
  return context.isCurrent(sender.frameId, sender.documentId);
}

function capture(url: string, pageUrl: string, audioUrl?: string): CaptureMessage {
  return { type: "capture", payload: { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url, pageUrl, ...(audioUrl ? { audioUrl } : {}) } };
}

/**
 * A file address a site resolver in the page's MAIN world named. It is
 * taken only from the hosts that have a resolver, never for a server inside
 * the user's network that the browser itself was not answered from for this
 * tab, and without the user's cookies unless the browser itself received
 * that address in this tab.
 */
export function resolverCapture(payload: { readonly url: string | null; readonly audioUrl?: string | undefined }, sender: BridgeSender,
  context: RoutingContext): CaptureRoute | null {
  const senderUrl = sender.url ?? "";
  if (!payload.url || !isExtractorManagedHost(senderUrl)) return null;
  if ([payload.url, payload.audioUrl].some(target => !!target && unobservedLocalTarget(senderUrl, target, context.observedLocal))) return null;
  const received = context.received(payload.url) !== null && (!payload.audioUrl || context.received(payload.audioUrl) !== null);
  return {
    message: capture(payload.url, context.topUrl ?? sender.tabUrl ?? senderUrl, payload.audioUrl),
    options: {
      referrerPage: senderUrl,
      origin: { frameId: sender.frameId, documentId: sender.documentId, via: ["resolver"], scope: null },
      credentials: received ? "include" : "omit",
    },
  };
}

/**
 * A media address from the document's resource timeline: a request the
 * browser itself made. It carries the user's cookies only when this worker
 * also saw the browser receive it.
 */
export function observedCapture(url: string, requestType: "media" | "xmlhttprequest", sender: BridgeSender, context: RoutingContext): CaptureRoute | null {
  const pageUrl = webPage(context.topUrl, sender.tabUrl, sender.url) ?? "";
  if (!pageUrl || isExtractorManagedHost(pageUrl)) return null;
  const received = context.received(url);
  return {
    message: capture(url, pageUrl),
    options: {
      referrerPage: webPage(sender.url, sender.origin) ?? pageUrl,
      origin: { frameId: sender.frameId, documentId: sender.documentId,
        via: ["timing", requestType === "media" ? "network-media" : "network-fetch"], scope: null },
      credentials: received ? "include" : "omit",
      serverIp: received?.ip ?? null,
    },
  };
}

/**
 * The addresses of a job's requests that a public page must not make
 * savemedia send: a manifest, a key or a segment it points at inside the
 * user's network, on a server the browser itself was not answered from for
 * this tab.
 */
export function privateTargets(pageUrl: string, urls: readonly string[], observed?: ObservedLocal): string[] {
  return urls.filter(url => unobservedLocalTarget(pageUrl, url, observed));
}

/**
 * The quality group and the file name a frame declares for an address. A
 * frame speaks for media it loaded itself and for the frames inside it. An
 * embedded frame cannot rename or regroup a video another frame loaded:
 * `owner` is the frame the browser loaded the address in, when that is known.
 */
export function declaredDetails(
  request: { readonly frameId: number; readonly groupId?: string | undefined; readonly height?: number | undefined; readonly filenameHint?: string | undefined },
  owner: number | undefined, frames: TabMediaState["frames"],
): { quality?: { groupId: string; height?: number }; filenameHint?: string } {
  if (owner !== undefined && !inFrameTree(frames, owner, request.frameId)) return {};
  return {
    ...(request.groupId ? { quality: { groupId: request.groupId, ...(request.height ? { height: request.height } : {}) } } : {}),
    ...(request.filenameHint ? { filenameHint: request.filenameHint } : {}),
  };
}
