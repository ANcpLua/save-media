import type { Logger } from "../util/logger";
import { MAIN_BRIDGE_TAG } from "../types/messages";
import { MAX_ADDRESS_LENGTH, playlistIdentity, withoutHash, mayBeFetchedFile, worthProbing } from "../util/media-url";
import { isPrivateAddress, webOrigin, webPage } from "../util/address-space";
import type { CaptureHandler } from "./capture";
import type { FrameTracker } from "./frames";
import type { TabMediaStore } from "./tab-media";
import type { ManagedSite } from "../types/page-facts";

interface ResponseDetails {
  readonly requestId: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly url: string;
  readonly method?: string | undefined;
  readonly type?: string | undefined;
  readonly statusCode: number;
  readonly ip?: string | undefined;
  readonly fromCache?: boolean | undefined;
  readonly initiator?: string | undefined;
  readonly documentId?: string | undefined;
  readonly documentLifecycle?: string | undefined;
  readonly responseHeaders?: readonly { readonly name: string; readonly value?: string | undefined }[] | undefined;
}

/**
 * The origins a tab's navigations were answered from at a local address, until the tab shows the document.
 * The browser answers a navigation before the tab shows the new document, and showing it clears what the
 * tab knew of the old one: the origin waits here and is noted for the new document once it is shown.
 */
export interface TopDocumentAnswers {
  note(tabId: number, url: string): void;
  /** The tab shows `url` now. Its origin, when a navigation of the tab was answered from there at a local address. */
  take(tabId: number, url: string): string | null;
  forget(tabId: number): void;
}

/** A navigation that never ends in a document (a download, a cancelled load) leaves its origin here: a few are kept per tab. */
const MAX_WAITING_ORIGINS = 8;

export function createTopDocumentAnswers(): TopDocumentAnswers {
  const waiting = new Map<number, Set<string>>();
  return {
    note(tabId, url) {
      const origin = webOrigin(url);
      if (!origin) return;
      const origins = waiting.get(tabId) ?? new Set<string>();
      origins.delete(origin);
      origins.add(origin);
      if (origins.size > MAX_WAITING_ORIGINS) origins.delete(origins.values().next().value!);
      waiting.set(tabId, origins);
    },
    take(tabId, url) {
      const origin = webOrigin(url);
      return origin && waiting.get(tabId)?.delete(origin) ? origin : null;
    },
    forget(tabId) { waiting.delete(tabId); },
  };
}

export interface NetworkCaptureDeps {
  /** Where the answers to a tab's own navigations wait until the tab shows the document. Without it they are not noted. */
  readonly topDocuments?: TopDocumentAnswers;
  readonly handleCapture: CaptureHandler;
  readonly store: Pick<TabMediaStore, "touch" | "noteReceived" | "noteFetched"> & {
    /** The browser itself was answered from this address's origin at an address inside the user's network. */
    noteLocalOrigin(tabId: number, url: string): void;
  };
  readonly frames: Pick<FrameTracker, "frameUrl" | "generation">;
  /** The tab's address, for a tab whose top frame is not recorded yet. */
  readonly tabUrl: (tabId: number) => Promise<string | undefined>;
  /** Resolves when the worker's stored state is back in memory. Nothing is noted before. */
  readonly ready?: Promise<void>;
  /** Hears a response that could not be noted: a failure here is never silent. */
  readonly logger?: Pick<Logger, "error">;
}

/**
 * Only media element requests and fetch/XHR can carry media or a playlist:
 * images, scripts, styles and fonts never reach the service worker.
 */
const TYPES = ["media", "xmlhttprequest"] as const;

/**
 * A tab's own documents: its page and its frames. Their answers are never looked at for media. They say
 * one thing only: that the browser itself reached the document's origin at an address inside the user's
 * network. A page behind an intranet name, or behind a proxy on this computer, is such a document.
 */
const DOCUMENT_TYPES = ["main_frame", "sub_frame"] as const;

/**
 * Observe the responses the browser itself received. A response decides
 * what is worth a probe by its request type and its Content-Type, and the
 * probe's bytes decide what is offered. Nothing is requested before the
 * browser received a 200 or 206 for the address, so a page cannot make
 * savemedia request an address its own browser could not load.
 *
 * A response is taken when it has started, not when its headers arrived:
 * only then does the browser name the server address it came from. That
 * address is what tells that the browser itself was answered from inside
 * the user's network, and it is noted before the response is looked at.
 */
export function registerNetworkCapture(deps: NetworkCaptureDeps): void {
  const webRequest = chrome.webRequest;
  if (!webRequest?.onResponseStarted) return;
  const filter = { urls: ["<all_urls>"], types: [...TYPES] } as chrome.webRequest.RequestFilter;
  // With stored state to wait for, a response is noted once it is back; otherwise at once.
  const ready = deps.ready;
  const whenReady = (work: () => unknown): void => {
    const failed = (error: unknown): void => deps.logger?.error("capture failed", { error: String(error) });
    if (ready) void ready.then(work).catch(failed);
    else {
      try { void Promise.resolve(work()).catch(failed); }
      catch (error) { failed(error); }
    }
  };

  // A redirect chain keeps the entry address the page actually used.
  const redirects = new Map<string, string>();
  webRequest.onBeforeRedirect.addListener(details => {
    if (!isPageGet(details)) return;
    // A redirect is an answer too: the server that sent it is one the browser reached.
    if (answeredLocally(details)) whenReady(() => deps.store.noteLocalOrigin(details.tabId, details.url));
    if (redirects.has(details.requestId)) return;
    if (redirects.size >= 512) redirects.delete(redirects.keys().next().value!);
    redirects.set(details.requestId, details.url);
  }, filter);

  webRequest.onResponseStarted.addListener(details => {
    whenReady(() => onResponse(deps, details as ResponseDetails, redirects));
  }, filter, ["responseHeaders"]);

  // One event per navigation, without headers: only the server address is read.
  const documents = { urls: ["<all_urls>"], types: [...DOCUMENT_TYPES] } as chrome.webRequest.RequestFilter;
  const document = (details: DocumentDetails): void => {
    if (details.tabId >= 0 && answeredLocally(details)) whenReady(() => onDocumentAnswer(deps, details));
  };
  webRequest.onBeforeRedirect.addListener(document, documents);
  webRequest.onResponseStarted.addListener(document, documents);
}

interface DocumentDetails {
  readonly tabId: number;
  readonly url: string;
  readonly type?: string | undefined;
  readonly ip?: string | undefined;
  readonly documentLifecycle?: string | undefined;
}

/**
 * Exported for tests: the browser's own navigation was answered from an address inside the user's network.
 * A frame's origin is noted for the tab's document at once. The page's own origin waits until the tab shows
 * the new document, and is noted at once as well when the tab already shows a document of that origin.
 */
export function onDocumentAnswer(deps: Pick<NetworkCaptureDeps, "store" | "frames" | "topDocuments">, details: DocumentDetails): void {
  if (details.type !== "main_frame") {
    // A frame of a page that is loaded ahead of time belongs to no document the tab shows.
    if (details.documentLifecycle === undefined || details.documentLifecycle === "active") deps.store.noteLocalOrigin(details.tabId, details.url);
    return;
  }
  deps.topDocuments?.note(details.tabId, details.url);
  const shown = webOrigin(deps.frames.frameUrl(details.tabId, 0));
  if (shown !== null && shown === webOrigin(details.url)) deps.store.noteLocalOrigin(details.tabId, details.url);
}

/**
 * Whether the browser's own request was answered from inside the user's
 * network: by the server address the browser reports, or, when it reports
 * none (an answer from its cache), by an address that is itself a local one.
 */
function answeredLocally(details: { url: string; ip?: string | undefined }): boolean {
  if (details.ip) return isPrivateAddress(details.ip);
  try { return isPrivateAddress(new URL(details.url).hostname); } catch { return false; }
}

function isPageGet(details: { tabId: number; method?: string | undefined; documentLifecycle?: string | undefined }): boolean {
  return details.tabId >= 0 && (details.method === undefined || details.method === "GET")
    && (details.documentLifecycle === undefined || details.documentLifecycle === "active");
}

function header(details: ResponseDetails, name: string): string {
  return details.responseHeaders?.find(item => item.name.toLowerCase() === name)?.value ?? "";
}

/** Exported for tests: one response the browser received. */
export async function onResponse(deps: NetworkCaptureDeps, details: ResponseDetails, redirects: Map<string, string>): Promise<void> {
  if (!isPageGet(details)) return;
  // Any answer counts, whatever its status and its type: the browser reached that server for this tab.
  if (answeredLocally(details)) deps.store.noteLocalOrigin(details.tabId, details.url);
  // A redirect hop keeps its entry for the final response.
  if (details.statusCode >= 300 && details.statusCode < 400) return;
  const entryUrl = redirects.get(details.requestId);
  redirects.delete(details.requestId);
  if (details.statusCode !== 200 && details.statusCode !== 206) return;
  const type = details.type ?? "";
  if (type !== "media" && type !== "xmlhttprequest") return;

  const { tabId, frameId } = details;
  const url = withoutHash(details.url);
  // An address longer than savemedia works with is not noted anywhere.
  if (url.length > MAX_ADDRESS_LENGTH || (entryUrl?.length ?? 0) > MAX_ADDRESS_LENGTH) return;
  const generation = deps.frames.generation(tabId, frameId);
  const ofKnownStream = deps.store.touch(tabId, url, frameId, generation);
  const seen = { via: "request" as const, type, mime: header(details, "content-type"), disposition: header(details, "content-disposition") };
  const entry = entryUrl ? withoutHash(entryUrl) : undefined;
  if (!worthProbing(url, seen) && !(entry && worthProbing(entry, seen))) {
    // A video a script fetched whole may be a file the page plays from memory. It is noted, with the server
    // that answered, and nothing is requested: the user's look at the page checks it (selection/main-video.ts).
    // An address of a stream savemedia already knows is a part of that stream, and is not noted.
    // A page a site reader owns is left to its reader.
    if (!ofKnownStream && mayBeFetchedFile(url, { type, status: details.statusCode, mime: seen.mime })
      && !isExtractorManagedHost(deps.frames.frameUrl(tabId, 0) ?? "")) {
      deps.store.noteFetched(tabId, url, frameId, details.documentId ?? null, details.ip ?? null);
    }
    return;
  }

  // The address of the server that answered. An answer from the browser's cache has none.
  const ip = details.ip ?? null;
  deps.store.noteReceived(tabId, playlistIdentity(url), ip, frameId);
  if (entry) deps.store.noteReceived(tabId, playlistIdentity(entry), ip, frameId);
  const pageUrl = webPage(deps.frames.frameUrl(tabId, 0)) ?? webPage(await deps.tabUrl(tabId)) ?? webPage(details.initiator) ?? url;
  // A site resolver owns discovery on this page; skip the generic path.
  if (isExtractorManagedHost(pageUrl)) return;
  // The frame that made the request: the browser sent its origin as Referer.
  // A frame without an address of its own sends its creator's origin, which the browser reports as the initiator.
  const referrerPage = webPage(deps.frames.frameUrl(tabId, frameId), details.initiator) ?? pageUrl;
  await deps.handleCapture(tabId, {
    type: "capture",
    payload: { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: entry ?? url, pageUrl },
  }, {
    ...(entry ? { observedUrl: url } : {}),
    referrerPage,
    origin: { frameId, documentId: details.documentId ?? null, via: [type === "media" ? "network-media" : "network-fetch"], scope: null },
    credentials: "include",
    serverIp: ip,
    // What the browser's own answer said about itself. An address named as an ad is listed from this alone.
    observedHeaders: Object.fromEntries((details.responseHeaders ?? []).flatMap(item => item.value === undefined ? [] : [[item.name.toLowerCase(), item.value]])),
  });
}

// Hosts where a dedicated MAIN-world site resolver (content/sites/*) is the
// authoritative source of the download URL(s). Generic webRequest sniffing
// on these pages only surfaces demuxed video-only noise that would outrank the
// real download, so we suppress it here. Deliberate mirror of the resolver
// `ownsHost` patterns. googlevideo.com is the youtube media CDN, never a
// resolver page host, but a request without page context falls back to the
// request address itself, and those must not enter generic discovery either.
const EXTRACTOR_MANAGED_HOST =
  /(^|\.)(twitter\.com|x\.com|instagram\.com|youtube\.com|youtube-nocookie\.com|googlevideo\.com)$/i;

export function isExtractorManagedHost(pageUrl: string): boolean {
  try {
    return EXTRACTOR_MANAGED_HOST.test(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

// The hosts of the one site reader store packages leave out
// (content/sites/registry.ts): its pages and its media servers.
const STORE_EXCLUDED_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|googlevideo\.com)$/i;

/**
 * True when one of the addresses is on the site whose reader store packages
 * leave out. A store package offers none of that site's media. Network
 * capture and the page bridge skip its pages in every build (above); the
 * addresses such a page declares, and the ones its players hold, are checked
 * on the user's request, and a store package leaves those checks out by this
 * test (background/index.ts). Other builds check them like any page's.
 */
export function onStoreExcludedSite(...addresses: readonly (string | null | undefined)[]): boolean {
  return addresses.some(address => {
    try {
      return !!address && STORE_EXCLUDED_HOST.test(new URL(address).hostname);
    } catch {
      return false;
    }
  });
}

/**
 * How the tab's page is read, when it is on a site with a site reader: by the reader this build has, or,
 * in a store package on the site whose reader it leaves out, not at all. Network capture and the page
 * bridge skip such a page in every build (above), so the selector is told: it then says that savemedia
 * does not save videos from this site, or that the reader found nothing, and never advises to start
 * playback, which cannot help there. Null for every other page.
 */
export function managedSite(pageUrl: string | null | undefined, storeBuild: boolean): ManagedSite | null {
  if (!pageUrl || !isExtractorManagedHost(pageUrl)) return null;
  return storeBuild && onStoreExcludedSite(pageUrl) ? "left-out" : "reader";
}
