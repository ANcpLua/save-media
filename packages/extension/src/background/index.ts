// MUST be the first import. Shims window→globalThis so transitively
// loaded videojs parsers (m3u8-parser, mpd-parser) don't crash the SW
// at module-load with `ReferenceError: window is not defined`.
import "../sw-globals-polyfill";
import type { JobError, StreamDescriptor } from "@savemedia/core";
import { downloadOptions } from "../util/downloadable";
import { playlistIdentity } from "../util/media-url";
import { canonicalAddress, fileIdentity, offersFile, sourceAddress } from "../util/media-address";
import { createDiagnosticJournal, createDiagnosticsObserver, diagnosticReport } from "./save-diagnostics";
import { VIEW_PORT, parseViewMessage } from "../types/messages";
import type {
  AdVia, BackgroundToContentMessage, BackgroundToPopupMessage, DescriptorsMessage, EngineEvent, HotkeyFeedbackOutcome,
  PopupReply, PopupRequest,
} from "../types/messages";
import { answeredWithoutVideo, recoverInterruptedDownload, settleResumedDownload } from "./interrupted-download";
import {
  answerRepeat, configureSaves, dismissRepeats, importSaves, namedFileIdentity, permitFrom, repeatPrompt, reserveSave, savedThisSession,
} from "./session-saves";
import { createRouter, type Router } from "./router";
import { saveVerifiedDownload } from "./browser-download";
import { createDownloadWatch } from "./download-watch";
import { createCaptureHandler } from "./capture";
import { createDiagnosticFetch } from "./diagnostic-fetch";
import { createRequestOutcomes } from "./request-outcomes";
import { explainNetwork, withOutcome } from "./explain-network";
import { createDispatcher, senderKind, type BridgeHandlers, type MessageSender, type PopupHandlers } from "./dispatch";
import { forgetHotkeyRun, isAltSShortcut, registerDownloadBestCommand, saveFromHotkey, saveFromPopup, saveImageAtPointer, scanTab, type DownloadBestDeps, type Scan } from "./download-best";
import { createEngineChannel, createInProcessEngineChannel, type EngineChannel } from "./engine-channel";
import { createEventHub, type BackgroundEvent } from "./events";
import { createFrameTracker, type NavigationApi } from "./frames";
import { factsOfCurrentRoutes, createFactsCollector, createRouteFollower } from "./page-facts";
import { createRecoveries } from "./recoveries";
import { createRefererRules } from "./referer-rules";
import { createTabMediaStore, STORED_PARTS, urlsOf, type Origin, type StoredPart } from "./tab-media";
import { protectionRowAddress } from "../util/tab-media-state";
import { declaredDetails, fromShownDocument, observedCapture, privateTargets, resolverCapture, type BridgeSender, type RoutingContext } from "./bridge-routing";
import { createImageSaver } from "./image-save";
import { rehydrate, routerPersistence } from "./state/rehydrate";
import { stateKeys, type ConfirmRequest, type StoredState } from "./state/records";
import { createSessionStore, type SessionArea } from "./state/session-store";
import { select, selectionView, type Selection } from "../selection/main-video";
import type { PageFileState, TabFacts } from "../types/page-facts";
import { MAIN_BRIDGE_TAG } from "../types/messages";
import { reachedLocallyByName, webPage } from "../util/address-space";
import { thinDescriptor } from "../util/thin-descriptor";
import { pageReach, type PageReachKind } from "../util/page-reach";
import { REPEAT, TOOLBAR, pageReachText } from "../ui/text";
import { TOAST_LABELS, toastDuration } from "../ui/toast-text";
import {
  clearToolbarNotice, flashToolbar, forgetToolbarTab, importToolbar, onToolbarNotices, onToolbarPainted, paintToolbarNotice, resetStaleToolbar,
  showToolbarNotice, toolbarBusy, updateToolbarProgress,
} from "./toolbar-progress";
import { localTransfer, type TransferState } from "../util/transfer-progress";
import { createHotkeyObserver } from "./hotkey-jobs";
import { createTopDocumentAnswers, managedSite, onStoreExcludedSite, registerNetworkCapture } from "./network-capture";
import { handleInstalled } from "./installed";
import { engineDocument } from "../platform/processor-host";
import { createLocalEngine } from "../platform/local-engine";
import { consoleLogger } from "../util/logger";
import { reportUncaught } from "../util/uncaught";
import { createNativeHostClient } from "../native/host-client";
import { createLocalDownloader } from "../native/local-downloader";

declare const __BROWSER__: "chromium" | "firefox";
/** Set by vite.config.ts: true in store packages (`bun run zip`). */
declare const __STORE_BUILD__: boolean;

const logger = consoleLogger("bg");
// A listener that throws and a promise nobody handles are logged like every other failure of the worker's own code.
reportUncaught(globalThis, detail => logger.error("uncaught error", { error: detail }));

// The saved settings, the local downloader's opt-in among them, are for the extension's own pages and this
// worker only. By default the browser also lets a tab's content script read and write them, and a page that
// took over its renderer could then switch the local downloader on without the popup.
try {
  void Promise.resolve(chrome.storage?.local?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" as never })).catch(() => undefined);
} catch { /* A browser without access levels for this area. */ }
const runtimeInfo = { id: chrome.runtime.id, getURL: (path: string) => chrome.runtime.getURL(path) };

// ---------------------------------------------------------------------------
// State that survives a worker restart. Everything below is created in this
// one synchronous pass, and every listener waits for `ready`: the stored
// state is back in memory before the first event is handled.
// ---------------------------------------------------------------------------

let resolveReady!: () => void;
const ready = new Promise<void>(resolve => { resolveReady = resolve; });

let router: Router;

/**
 * What may be dropped when the browser refuses a write: the diagnostics, and
 * the stored state of each tab without a save, one group per tab. Never jobs,
 * questions, resumes or receipts.
 */
function expendable(): readonly (readonly string[])[] {
  const idle = router.storedTabs().filter(tab => !tab.hasJob);
  return [
    journal.storedTabs().map(tabId => stateKeys.diagnostics(tabId)),
    ...idle.map(tab => [
      ...STORED_PARTS.map(part => stateKeys[part](tab.tabId)), stateKeys.covered(tab.tabId),
      ...tab.ids.map(id => stateKeys.descriptor(tab.tabId, id)), stateKeys.tab(tab.tabId),
    ]),
  ];
}

const sessionStore = createSessionStore(chrome.storage?.session as unknown as SessionArea | undefined, { expendable, logger });
const hub = createEventHub(logger);
const watch = createDownloadWatch(chrome.downloads, true);
const journal = createDiagnosticJournal(sessionStore, tabId => chrome.tabs.get(tabId).then(tab => !!tab.incognito));
const rules = createRefererRules(chrome.declarativeNetRequest, new URL(chrome.runtime.getURL("")).host,
  { onChange: records => sessionStore.put(stateKeys.rules, records), logger });
onToolbarPainted(tabIds => sessionStore.put(stateKeys.toolbar, tabIds));
onToolbarNotices(notices => sessionStore.put(stateKeys.notices, notices));

/** Tabs this worker saw start loading a document: their content script was injected then. */
const loaded = new Set<number>();
function noteLoaded(tabId: number): void {
  if (loaded.has(tabId)) return;
  loaded.add(tabId);
  sessionStore.put(stateKeys.loaded, [...loaded]);
}

/** The most text of a tab's last facts that is stored. A page that reports more is looked at again after a restart. */
const MAX_STORED_FACTS = 256 * 1024;

function storeMedia(tabId: number, part: StoredPart): void {
  // The store serializes when it writes, so the live objects are handed over as they are.
  const state = store.tab(tabId);
  if (part === "origins") sessionStore.put(stateKeys.origins(tabId), state.origins);
  else if (part === "activity") sessionStore.put(stateKeys.activity(tabId), state.activity);
  else if (part === "facts") {
    if (state.facts && JSON.stringify(state.facts).length <= MAX_STORED_FACTS) sessionStore.put(stateKeys.facts(tabId), state.facts);
    else sessionStore.delete(stateKeys.facts(tabId));
  }
  else if (part === "received") sessionStore.put(stateKeys.received(tabId), { received: state.received, earlier: state.earlier,
    localOrigins: state.localOrigins, fetched: state.fetched });
  else sessionStore.put(stateKeys.media(tabId), { topDocument: state.topDocument, loadFailed: state.loadFailed, frames: state.frames, ads: state.ads,
    assetLists: state.assetLists, timelines: state.timelines, elementDrm: state.elementDrm });
}
const store = createTabMediaStore(Date.now, storeMedia);

/**
 * What the browser reports about savemedia's own requests, in memory only. It explains a failure
 * (a block by the user's network, a certificate the browser refused) and is never used to reach a
 * server another way.
 */
const outcomes = createRequestOutcomes(chrome.webRequest, chrome.runtime.getURL("").replace(/\/$/, ""));

const recoveries = createRecoveries({ store: sessionStore, events: hub, watch, generation: tabId => router.generation(tabId), permitFrom,
  settle: downloadId => settleResumedDownload(chrome.downloads, downloadId) });

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

async function onEngineEvent(msg: EngineEvent): Promise<void> {
  if (imageSaver.handleEngineMessage(msg)) return;
  await router.handleEngineMessage(msg);
}

/**
 * The page's own player sends its Referer to these hosts; the job's requests do the same, for as long as the job runs.
 * The Referer is the one the check of the stream sent: the frame that loaded it, which for an embedded player is not the tab's page.
 */
async function prepareRequests(streamId: string, urls: readonly string[]): Promise<void> {
  const job = router.job(streamId);
  if (!job) return;
  // The engine refuses a job a public page points into the user's network, at a server the browser itself was not
  // answered from for the tab (runner.ts); no rule is made for such a host either.
  const inside = new Set(privateTargets(job.pageUrl, urls, url => store.localOrigin(job.tabId, url)));
  const page = job.referrer ?? job.pageUrl;
  await Promise.all([...new Set(urls)].filter(url => !inside.has(url)).map(url => rules.hold(streamId, url, page)));
}

async function onEngineLost(when: "running" | "restart"): Promise<void> {
  imageSaver.engineLost();
  await router.failEngineJobs(when);
}

const engine: EngineChannel = __BROWSER__ === "firefox" && createLocalEngine
  ? createInProcessEngineChannel(createLocalEngine, { ready, onEvent: onEngineEvent, onLost: onEngineLost, prepareRequests, logger })
  : createEngineChannel({
    ready,
    onEvent: onEngineEvent,
    onHello: async hello => {
      // An image nobody waits for any more only has its Blob to free.
      for (const kept of hello.outbox) if (kept.type === "image-complete") imageSaver.handleEngineMessage(kept);
      await router.reconcileEngine(hello);
    },
    onLost: onEngineLost,
    busy: () => router.engineJobCount() > 0 || imageSaver.busy(),
    prepareRequests,
    host: engineDocument,
    runtime: {
      ...runtimeInfo,
      onConnect: chrome.runtime.onConnect as never,
      wake: () => new Promise<boolean>(resolve => {
        try {
          chrome.runtime.sendMessage({ type: "engine-connect" }, (reply?: { ok?: boolean }) => resolve(!chrome.runtime.lastError && reply?.ok === true));
        } catch { resolve(false); }
      }),
    },
    logger,
  });

router = createRouter({
  engine,
  downloads: {
    download: opts => chrome.downloads.download(opts as chrome.downloads.DownloadOptions),
    wait: id => watch.wait(id),
    filename: async id => {
      const [item] = await chrome.downloads.search({ id });
      return item?.filename.split(/[/\\]/).at(-1);
    },
    findByUrl: url => watch.findByUrl(url),
  },
  // Where the browser reaches the tab's own page at a local address, the addresses it reports explain nothing.
  explainNetwork: (error, context) => explainNetwork(outcomes, error,
    { since: context.since, address: context.address, addressesSayNothing: reachedLocallyByName(context.pageUrl, url => store.localOrigin(context.tabId, url)) }),
  reserveSave: async (descriptor, choice, named, { origin, allowRepeat }) => {
    const {tabId, pageUrl, source} = descriptor;
    const request: ConfirmRequest = { kind: "stream", streamId: descriptor.id, choice, file: named ?? null, origin };
    if (source.kind === "direct-url") {
      const offer = named ?? await collector.offeredFile(tabId, pageUrl);
      if (offer && (named?.pageUrl === pageUrl || offer.filename === descriptor.title || offer.filename === choice.filename)) {
        return reserveSave(namedFileIdentity(pageUrl, offer.filename), tabId, pageUrl, offer.filename, { request, allowRepeat });
      }
    }
    // A direct file is identified by its validators and length, so a renewed
    // signature on the same file keeps its receipt and its retained bytes.
    const identity = source.kind === "direct-url" ? [source.kind, fileIdentity(source.url, source.headers)]
      : [source.kind, canonicalAddress(sourceAddress(descriptor)),
        canonicalAddress(choice.variantId ?? ""), canonicalAddress(choice.audioRenditionId ?? "")];
    return reserveSave(identity, tabId, pageUrl, choice.filename, { request, allowRepeat });
  },
  permitFrom,
  events: hub,
  persist: routerPersistence(sessionStore),
  referrerOf: descriptor => {
    const origins = store.tab(descriptor.tabId).origins;
    return urlsOf(descriptor).map(url => origins[url]?.referrer).find(referrer => !!referrer) ?? null;
  },
  localOriginsOf: tabId => store.localOrigins(tabId),
  // The rows the selection shows as the main video are never dropped for a newer capture.
  keep: tabId => {
    const selection = selectFor(tabId, null, false);
    return new Set<string>([...(selection.main ? [selection.main] : []), ...selection.candidates]);
  },
  logger,
});

configureSaves({
  store: sessionStore,
  // An Alt+S press that ended in a question does not hold back the tab's next press.
  onQuestion: tabId => forgetHotkeyRun(tabId),
  // The popup could not be opened to ask: the page and the toolbar button say where the question waits.
  onAsked: tabId => showHotkeyFeedback(tabId, "asked", REPEAT.toast),
  // An allowed repeat whose answer arrived after a worker restart: start what was asked for again.
  redispatch: async request => {
    if (request.kind === "stream") await router.startDownload(request.streamId, request.choice, { file: request.file ?? undefined, origin: request.origin });
    else if (request.kind === "page") await saveFromPopup(downloadBestDeps, request.tabId, request.pageUrl);
    // The image the question was about, never the page's video.
    else if (request.image) await saveImageAtPointer(downloadBestDeps, request.tabId, request.pageUrl, request.image);
    else showHotkeyFeedback(request.tabId, "asked", REPEAT.pressAgain);
  },
});

// The browser's navigation events can start the worker: they are handled once the stored state is back.
const navigation: NavigationApi | undefined = chrome.webNavigation ? {
  getAllFrames: details => chrome.webNavigation.getAllFrames(details) as ReturnType<NavigationApi["getAllFrames"]>,
  onCommitted: { addListener: listener => chrome.webNavigation.onCommitted.addListener(whenReady(listener as never) as never) },
  onHistoryStateUpdated: { addListener: listener => chrome.webNavigation.onHistoryStateUpdated.addListener(whenReady(listener as never) as never) },
  onErrorOccurred: { addListener: listener => chrome.webNavigation.onErrorOccurred?.addListener(whenReady(listener as never) as never) },
} : undefined;

const topDocuments = createTopDocumentAnswers();

const frames = createFrameTracker(navigation, store, {
  // A new top document: a load, a reload, or a page restored from the back-forward cache.
  topDocument: (tabId, url) => {
    noteLoaded(tabId);
    // A save that still waits for the old page's frames is not this page's.
    forgetHotkeyRun(tabId);
    imageSaver.leftPage(tabId);
    clearTab(tabId, url);
    // The browser was answered for this document from inside the user's network: its origin is one the browser reached there.
    const local = topDocuments.take(tabId, url);
    if (local) store.noteLocalOrigin(tabId, local);
    dismissRepeats(tabId);
    clearToolbarNotice(tabId);
    changed(tabId);
  },
  // A subframe shows a new document: what its old document loaded is gone.
  frameDocument: (tabId, frameId) => {
    const now = frames.documentId(tabId, frameId);
    const stale = (urls: readonly string[]): boolean => {
      const origin = store.originOf(tabId, urls);
      return !!origin && origin.frameId === frameId && origin.documentId !== null && origin.documentId !== now;
    };
    const gone = router.descriptors(tabId).filter(d => stale(urlsOf(d)));
    const failed = router.failures(tabId).filter(failure => stale([failure.url])).map(failure => failure.url);
    handleCapture.forget(tabId, [...gone.flatMap(urlsOf), ...failed]);
    const removed = router.removeDescriptors(tabId, gone.map(d => d.id)) + router.removeFailures(tabId, failed);
    if (removed) changed(tabId);
  },
  // A route change without a new document: what is listed follows the new route.
  navigated: tabId => followRoute(tabId),
});

const collector = createFactsCollector({
  frames,
  // A frame without a reachable content script answers with an error at once.
  send: (tabId, target, msg) => chrome.tabs.sendMessage(tabId, msg, target).catch(() => null),
  store,
});

/** The facts last read for the tab, without those of a frame that changed its route since. */
function storedFacts(tabId: number): TabFacts | null {
  return factsOfCurrentRoutes(store.tab(tabId).facts, frameId => frames.generation(tabId, frameId));
}

function selectFor(tabId: number, facts: TabFacts | null, usePointer: boolean): Selection {
  // On a site that is read by a site reader alone, the selector says so where it has nothing to offer.
  return select({ descriptors: router.descriptors(tabId), failures: router.failures(tabId), media: store.tab(tabId),
    jobs: router.activeJobs(tabId), facts: facts ?? storedFacts(tabId), usePointer, site: managedSite(frames.frameUrl(tabId, 0), __STORE_BUILD__) });
}

// A popup or detached window keeps a port open and says which tab it shows.
// A tab's list is sent only while a view shows that tab, and job updates
// only while any view is open: with no popup open, nothing is serialized.
const views = new Map<chrome.runtime.Port, number | null>();
const viewShows = (tabId: number): boolean => [...views.values()].includes(tabId);

// Facts read on the route before say what the players held then. While a popup shows the tab, the page is
// read again, so that popup follows what the players hold now. Otherwise the user's next look reads it.
const followRoute = createRouteFollower({
  looked: tabId => store.tab(tabId).facts !== null,
  shown: viewShows,
  read: tabId => collector.collect(tabId, { pointer: false, thumbnails: false }),
  changed,
});

/** What the tab lists may have changed: the toolbar count and the open popups follow. */
function changed(tabId: number): void {
  hub.emit({ type: "sources-changed", tabId });
}

/** A master playlist states no timeline: it takes the one its media playlist states, in either arrival order. */
function annotateMasters(tabId: number): boolean {
  const timelines = store.tab(tabId).timelines;
  let changed = false;
  for (const descriptor of router.descriptors(tabId)) {
    if (descriptor.source.kind !== "hls-manifest" || descriptor.source.type !== "master") continue;
    const presentation = urlsOf(descriptor).slice(1).map(url => timelines[url]).find(item => item !== undefined);
    if (presentation && router.annotate(tabId, descriptor.id, { presentation })) changed = true;
  }
  return changed;
}

/**
 * Addresses a page's own ad responses named. Such an address is never the
 * main video and is never requested on savemedia's own: a check of it that
 * is under way stops. What the browser itself loaded of it stays listed, as
 * an ad, and the user may save it. `frameId` is the frame that received the
 * response: the store decides whose media a frame may speak for.
 */
function markAds(tabId: number, urls: readonly string[], via: AdVia, frameId: number, assetLists: readonly string[] = []): void {
  store.noteAssetLists(tabId, assetLists);
  const added = store.markAds(tabId, urls, via, frameId);
  if (!added.length) return;
  for (const url of added) handleCapture.abortUrl(tabId, url);
  router.removeFailures(tabId, added);
  // The rows stay. What they are listed as has changed.
  changed(tabId);
}

/** The descriptor of a media element that used a key. The same element keeps the same row. */
function protectElement(tabId: number, frameId: number, documentId: string | null, key: string | null, keySystem: string | null,
  elementSrc: string | null): boolean {
  const entry = store.upsertElementDrm(tabId, frameId, documentId, key, keySystem, elementSrc);
  const known = router.findDescriptor(entry.id);
  if (known && known.drm?.keySystem === (entry.keySystem ?? "unknown")) return false;
  const source = protectionRowAddress(store.tab(tabId).origins, frameId, documentId, key, entry.elementSrc);
  router.removeDescriptors(tabId, [entry.id]);
  store.recordOrigin(tabId, source, { frameId, documentId, generation: frames.generation(tabId, frameId), via: ["eme"], scope: null });
  router.addDescriptor(tabId, {
    id: entry.id, tabId, pageUrl: frames.frameUrl(tabId, 0) ?? "", title: null, detectedAt: Date.now(),
    source: { kind: "media-element", element: "video", elementSrc: source },
    protocol: "unknown", container: "unknown", codecs: { video: null, audio: null, subtitles: [] }, variants: [],
    drm: { reason: entry.keySystem === "org.w3.clearkey" ? "clearkey_deferred" : "cdm_required", detectedVia: ["eme-hook"],
      keySystem: entry.keySystem ?? "unknown" },
    capabilities: { directDownload: false, remuxableTo: [] },
    confidence: { container: "guessed", codecs: "guessed", protocol: "guessed" },
  });
  return true;
}

/** Where an address was seen, without the Referer of its check: only a check that found media says what a save sends. */
function seenOnly(origin: Origin): Origin {
  const { referrer: _unconfirmed, ...seen } = origin;
  return seen;
}

const probeFetch = createDiagnosticFetch(outcomes);

const handleCapture = createCaptureHandler({
  onHttp: (tabId, observation) => hub.emit({ type: "http", tabId, generation: router.generation(tabId), source: "probe", streamId: null, observation }),
  fetchFn: probeFetch,
  serverHops: probeFetch.serverHops,
  observedLocal: (tabId, url) => store.localOrigin(tabId, url),
  explain: async (error, response, url, signal, addressesSayNothing) =>
    withOutcome(error, response ? await probeFetch.outcomeOf(response, signal) : null, url, addressesSayNothing),
  // A check holds its rules until it ends, so another page's check cannot switch them between its requests.
  mirrorReferer: (url, pageUrl, holder) => rules.hold(holder, url, pageUrl),
  releaseReferer: holder => rules.release(holder),
  isAd: (tabId, url) => store.isAd(tabId, url),
  generation: (tabId, frameId) => frames.generation(tabId, frameId),
  onSeen: (tabId, url, origin) => {
    const before = store.originOf(tabId, [url])?.generation;
    store.recordOrigin(tabId, url, seenOnly(origin));
    // Seen again on a new route: it is listed again.
    if (before !== undefined && origin.generation > before) changed(tabId);
  },
  onAds: (tabId, urls, via, assetLists, frameId) => markAds(tabId, urls, via, frameId, assetLists),
  onTimeline: (tabId, url, presentation) => {
    store.recordTimeline(tabId, url, presentation);
    if (annotateMasters(tabId)) changed(tabId);
  },
  onDescriptor: (tabId, descriptor, origin) => {
    for (const url of origin ? urlsOf(descriptor).slice(0, 1) : []) store.recordOrigin(tabId, url, origin!);
    // An ad that was listed from the browser's answer and is checked now, on the user's Save: the checked row takes its place.
    const address = urlsOf(descriptor)[0];
    if (!descriptor.unchecked && address !== undefined && store.isAd(tabId, address)) {
      router.removeDescriptors(tabId, router.descriptors(tabId).filter(d => d.unchecked && urlsOf(d)[0] === address).map(d => d.id));
    }
    const added = router.addDescriptor(tabId, descriptor);
    // Indexed from what the row keeps, so the index is the same one a restarted worker builds from the stored rows.
    store.indexOwners(tabId, thinDescriptor(descriptor));
    const annotated = annotateMasters(tabId);
    if (added || annotated) changed(tabId);
  },
  onFailure: (tabId, failure, origin) => {
    if (origin) store.recordOrigin(tabId, failure.url, seenOnly(origin));
    router.setDiscoveryFailure(tabId, failure);
    changed(tabId);
  },
  onPart: (tabId, url) => store.forgetFetched(tabId, url),
  onProbeSuccess: (tabId, url) => {
    if (router.clearDiscoveryFailure(tabId, url)) changed(tabId);
  },
  logger,
});

/** The document count of the tab when a local download started: its end is recorded only on that document. */
const localJobGenerations = new Map<string, number>();
const localDownloader = createLocalDownloader({
  client: createNativeHostClient({
    connectNative: name => chrome.runtime.connectNative(name),
    lastError: () => chrome.runtime.lastError as { readonly message?: string } | undefined,
  }),
  storage: {
    get: key => chrome.storage.local.get(key),
    set: items => chrome.storage.local.set(items),
  },
  permissions: {
    contains: perm => chrome.permissions.contains({ permissions: [...perm.permissions] as chrome.runtime.ManifestPermission[] }),
  },
  env: {
    browser: __BROWSER__, userAgent: navigator.userAgent,
    brands: (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } })
      .userAgentData?.brands.map(b => b.brand) ?? [],
  },
  onJobUpdate: (job, origin) => {
    if (job.tabId !== null && !localJobGenerations.has(job.id)) localJobGenerations.set(job.id, router.generation(job.tabId));
    hub.emit({ type: "local-job", tabId: job.tabId, generation: localJobGenerations.get(job.id) ?? null, job, origin });
    if (job.phase === "complete" || job.phase === "failed") localJobGenerations.delete(job.id);
  },
});

function notifyTab(tabId: number, outcome: HotkeyFeedbackOutcome, detail: string): void {
  const msg: BackgroundToContentMessage = { type: "hotkey-feedback", outcome, detail };
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, () => void chrome.runtime.lastError);
}

async function isOnPage(tabId: number, pageUrl: string): Promise<boolean> {
  return chrome.tabs.get(tabId).then(tab => tab.url === pageUrl, () => false);
}

async function exportDiagnostics(tabId: number, pageUrl: string): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.url !== pageUrl) return false;
  const report = diagnosticReport(journal, tabId, { url: tab.url ?? "", version: chrome.runtime.getManifest().version, browser: __BROWSER__ },
    router.failures(tabId));
  const filename = `savemedia-diagnostics-${report.exportedAt.replace(/[:.]/g, "-")}.json`;
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(report, null, 2));
  await saveVerifiedDownload(chrome.downloads, {url, filename, conflictAction: "uniquify", saveAs: false});
  return true;
}

/** The longest image address a repeat question keeps for a restarted worker. An image written into the page can be megabytes. */
const MAX_KEPT_IMAGE_ADDRESS = 8192;

const imageSaver = createImageSaver({
  mirrorReferer: rules.mirror,
  startEngine: msg => engine.start(msg),
  download: async (blobUrl, filename) => {
    const id = await saveVerifiedDownload(chrome.downloads, { url: blobUrl, filename, conflictAction: "uniquify", saveAs: false });
    const [item] = await chrome.downloads.search({ id });
    return item?.filename.split(/[\\/]/).at(-1) || filename;
  },
  release: blobUrl => engine.release(blobUrl),
  cancel: streamId => engine.cancel(streamId),
  // As for a video's save: where the browser reaches the tab's own page at a local address, the addresses it reports explain nothing.
  explainNetwork: (error, context) => explainNetwork(outcomes, error, { since: context.since, address: context.address,
    addressesSayNothing: context.tabId !== null && reachedLocallyByName(context.pageUrl, url => store.localOrigin(context.tabId!, url)) }),
});

/** Media elements that used a key get their protection descriptor, also when no event reached the worker. */
function noteKeyedElements(tabId: number, facts: TabFacts): void {
  let found = false;
  for (const frame of facts.frames) {
    for (const element of frame.elements) {
      if (!element.keyed) continue;
      const source = element.source.kind === "url" ? element.source.url : null;
      if (protectElement(tabId, frame.frameId, frame.documentId, element.key, element.keyed.keySystem, source)) found = true;
    }
  }
  if (found) changed(tabId);
}

/** Why the tab's page cannot be read, from the tab's address, its load state and the user's permissions. */
async function reachOf(tabId: number, answered: boolean): Promise<PageReachKind> {
  if (answered) return "reachable";
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url ?? frames.frameUrl(tabId, 0);
  let origin = "";
  try { origin = new URL(url ?? "").origin; } catch { /* not an address */ }
  const [fileAccess, hostAccess] = await Promise.all([
    Promise.resolve(chrome.extension?.isAllowedFileSchemeAccess?.()).then(value => value === true, () => false),
    origin && origin !== "null" ? chrome.permissions.contains({ origins: [`${origin}/*`] }).catch(() => false) : Promise.resolve(false),
  ]);
  return pageReach({ answered, url, status: tab?.status, observedLoad: loaded.has(tabId), fileAccess, hostAccess, loadFailed: frames.loadFailed(tabId) });
}

/** Alt+S where the page cannot be read: nothing is saved; the popup says why, or the toolbar button does. */
async function showUnreachable(tabId: number): Promise<void> {
  const reach = await reachOf(tabId, false);
  router.setPageReach(tabId, reach);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.active && chrome.action.openPopup) {
    try { await chrome.action.openPopup({ windowId: tab.windowId }); return; }
    catch { /* Some browsers open the popup only from a toolbar click. */ }
  }
  const text = pageReachText(reach);
  if (text) showToolbarNotice(tabId, TOOLBAR.notice(text.title));
}

const downloadBestDeps: DownloadBestDeps = {
  logger,
  tabs: {
    query: queryInfo => chrome.tabs.query(queryInfo),
    isOnPage,
  },
  collect: async (tabId, options) => {
    const facts = await collector.collect(tabId, options);
    noteKeyedElements(tabId, facts);
    return facts;
  },
  select: selectFor,
  // A check the user asked for, by opening the popup or pressing Alt+S: it carries the user's cookies.
  // A store package offers nothing of the site whose reader it leaves out, so it makes no such check there.
  probe: (tabId, request, retryFailed) => __STORE_BUILD__ && onStoreExcludedSite(frames.frameUrl(tabId, 0), request.frameUrl, request.url)
    ? Promise.resolve() : handleCapture(tabId, { type: "capture", payload: {
    [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: request.url, pageUrl: frames.frameUrl(tabId, 0) ?? request.frameUrl,
    ...declaredDetails(request, store.received(tabId, request.url)?.frameId ?? store.originOf(tabId, [request.url])?.frameId, store.tab(tabId).frames),
  } }, {
    referrerPage: webPage(request.frameUrl, frames.frameUrl(tabId, 0)) ?? request.frameUrl,
    // What a script fetched is a request of the document itself, like any other the browser made for it.
    origin: { frameId: request.frameId, documentId: request.documentId ?? frames.documentId(tabId, request.frameId),
      via: [request.via === "fetched" ? "network-fetch" : request.via], scope: request.via === "fetched" ? null : request.scope },
    retryFailed,
    credentials: "include",
    priority: true,
    ...(request.via === "fetched" ? { wholeFile: true, serverIp: store.fetched(tabId, request.url)?.ip ?? null } : {}),
  }),
  saveImage: image => imageSaver.save({ url: image.url, pageUrl: webPage(image.pageUrl, frames.frameUrl(image.tabId, 0)) ?? image.pageUrl,
    localOrigins: store.localOrigins(image.tabId), loaded: image.loaded, tabId: image.tabId }),
  // An image is the same image by its address. Its record keeps the address only while it is a short one.
  reserveImage: (tabId, pageUrl, image, name) => reserveSave(["image", canonicalAddress(image.url)], tabId, pageUrl, name,
    { request: { kind: "image", tabId, pageUrl, image: image.url.length <= MAX_KEPT_IMAGE_ADDRESS ? image : null } }),
  runtime: {
    sendMessage: (msg, cb) => { toViews(msg); cb?.(); },
  },
  router,
  recoverInterrupted: async (tabId, pageUrl, offer) => {
    if (__BROWSER__ !== "chromium" || protectedFile(router.snapshot(tabId).descriptors, offer.url)) return null;
    // savemedia's own look at this link was answered with something that is no video (an expired link's page):
    // the browser's resume would write that answer into the file. The file is downloaded afresh and checked instead.
    if (answeredWithoutVideo(router.failures(tabId), offer.url)) return null;
    return recoverInterruptedDownload(tabId, pageUrl, offer,
      (progress, error) => recoveries.update(tabId, pageUrl, progress, error),
      (downloadId, receiptKey) => recoveries.started(tabId, pageUrl, offer.filename, downloadId, receiptKey));
  },
  rememberFileSaveProblem: async (tabId, pageUrl, problem) => {
    hub.emit({ type: "file-save", tabId, generation: router.generation(tabId), pageUrl, problem });
    const msg = { type: "file-save-problem", tabId, pageUrl, problem } satisfies BackgroundToPopupMessage;
    await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => undefined);
    // The page's last report is what a popup is answered with. It was made before this result, so the result is
    // written into it: the reply to the popup's own Save must not take back the problem that Save just met.
    const facts = store.tab(tabId).facts;
    const top = facts?.frames.find(frame => frame.top);
    if (facts && top?.page && top.url === pageUrl) {
      const page: PageFileState = { ...top.page, fileSaveProblem: problem };
      store.setFacts(tabId, { ...facts, frames: facts.frames.map(frame => frame === top ? { ...top, page } : frame) });
    }
  },
  showHotkeyFeedback,
  showUnreachable: tabId => void showUnreachable(tabId),
  localFallback: (pageUrl, tabId) => localDownloader.startFallback(pageUrl, tabId),
};

/** The toolbar badge for each result. A cancel has none: the button goes back to the page's count. */
const FEEDBACK_BADGES: Record<HotkeyFeedbackOutcome, { text: string; color: string } | null> = {
  "preparing": { text: "…", color: "#2563eb" },
  "started": { text: "↓", color: "#16a34a" },
  "delegated": { text: "⇣", color: "#2563eb" },
  "complete": { text: "✓", color: "#16a34a" },
  "no-media": { text: "∅", color: "#6b7280" },
  "waiting": { text: "…", color: "#d97706" },
  "asked": { text: "?", color: "#d97706" },
  "failed": { text: "✗", color: "#dc2626" },
  "cancelled": null,
};

/** The result of an Alt+S press: a toast in the page, and the same words on the toolbar button for as long as the toast shows. */
function showHotkeyFeedback(tabId: number, outcome: HotkeyFeedbackOutcome, detail: string): void {
  notifyTab(tabId, outcome, detail);
  const badge = FEEDBACK_BADGES[outcome];
  if (!badge) { updateBadge(tabId); return; }
  const end = flashToolbar(tabId, badge, TOOLBAR.feedback(TOAST_LABELS[outcome], detail));
  if (end) setTimeout(() => { if (end()) updateBadge(tabId); }, toastDuration(outcome));
}

/**
 * A DRM signal on the offered file itself: its own probe found encryption.
 * A protected stream elsewhere on the page, such as an advert, says nothing
 * about this file, and Chrome's own resume of it goes ahead.
 */
function protectedFile(descriptors: readonly StreamDescriptor[], url: string): boolean {
  return descriptors.some(d => d.drm && offersFile(d, url));
}

// Fires once per store update, before any other event of the new version.
chrome.runtime.onInstalled.addListener(details => {
  void handleInstalled(details, {
    storage: {
      getAll: () => chrome.storage.local.get(null),
      set: items => chrome.storage.local.set(items),
      remove: keys => chrome.storage.local.remove([...keys]),
    },
    permissions: {
      contains: perm => chrome.permissions.contains({ permissions: [...perm.permissions] as chrome.runtime.ManifestPermission[] }),
    },
    log: message => logger.info(message),
  }, chrome.runtime.getManifest().version);
});

/** The tab shows a new top document. */
function clearTab(tabId: number, pageUrl?: string): void {
  handleCapture.clearTab(tabId);
  router.clearTab(tabId, pageUrl);
  store.reset(tabId);
}

/** The tab is gone, and everything stored for it with it. A running save finishes on its own. */
function closeTab(tabId: number): void {
  handleCapture.clearTab(tabId);
  router.forgetTab(tabId);
  store.forget(tabId);
  for (const part of STORED_PARTS) sessionStore.delete(stateKeys[part](tabId));
  recoveries.forgetTab(tabId);
  dismissRepeats(tabId);
  forgetToolbarTab(tabId);
  if (loaded.delete(tabId)) sessionStore.put(stateKeys.loaded, [...loaded]);
  topDocuments.forget(tabId);
}

/** Runs a listener's work once the stored state is back. */
function whenReady<A extends unknown[]>(listener: (...args: A) => void): (...args: A) => void {
  return (...args) => { void ready.then(() => listener(...args)).catch(error => logger.error("listener failed", { error: String(error) })); };
}

chrome.tabs.onRemoved.addListener(whenReady(tabId => closeTab(tabId)));
chrome.tabs.onReplaced?.addListener(whenReady((_addedTabId, removedTabId) => closeTab(removedTabId)));
// The browser reports no removed frame. When the user comes back to a tab, its frames are listed again,
// so what a removed frame had loaded leaves the tab's count without waiting for the popup or Alt+S.
chrome.tabs.onActivated?.addListener(whenReady(({ tabId }) => {
  if (store.has(tabId)) void frames.frames(tabId).catch(() => undefined);
}));
chrome.tabs.onUpdated.addListener(whenReady((tabId, info, tab) => {
  if (info.status === "loading") noteLoaded(tabId);
  // The frame tracker resets a tab when its top document changes. Without
  // the navigation events, a load is the only signal there is.
  if (!chrome.webNavigation && info.status === "loading") { clearTab(tabId, info.url ?? tab.url); clearToolbarNotice(tabId); changed(tabId); }
  if (info.url) {
    dismissRepeats(tabId);
  }
}));

/**
 * The browser itself was answered from a local server that is new for this tab. A source that was not
 * checked because the page only named such a server is checked again when it is next seen: its failure
 * and what the check remembers of it go.
 */
function localOriginNoted(tabId: number): void {
  const named = router.failures(tabId).filter(failure => failure.error.code === "private_network_target").map(failure => failure.url);
  if (!named.length) return;
  handleCapture.forget(tabId, named);
  if (router.removeFailures(tabId, named)) changed(tabId);
}

registerNetworkCapture({
  topDocuments,
  handleCapture,
  store: {
    touch: store.touch,
    noteReceived: store.noteReceived,
    noteFetched: store.noteFetched,
    noteLocalOrigin: (tabId, url) => { if (store.noteLocalOrigin(tabId, url)) localOriginNoted(tabId); },
  },
  frames,
  tabUrl: tabId => chrome.tabs.get(tabId).then(tab => tab.url, () => undefined),
  ready,
  logger,
});

registerDownloadBestCommand(chrome.commands, downloadBestDeps, ready, logger);

// ---------------------------------------------------------------------------
// Observers: the toolbar, the open popups, diagnostics and the Alt+S toast
// all follow the same events.
// ---------------------------------------------------------------------------

function showTransfer(tabId: number, id: string, status: TransferState | null): void {
  updateToolbarProgress(tabId, id, status);
  if (!status) updateBadge(tabId);
}

function updateBadge(tabId: number): void {
  // A running transfer owns the button, and a notice stays on it until the tab shows another page.
  if (toolbarBusy(tabId) || paintToolbarNotice(tabId)) return;
  // The same number as the popup's cards: one count for the tab.
  const count = selectFor(tabId, null, false).cards.length;
  const text = count > 0 ? String(count) : "";
  // Tab can vanish between an in-flight async classify and this badge
  // update. chrome.action.setBadge* rejects with "No tab with id: N";
  // we don't care — the tab is gone, the badge is moot. Catch and drop.
  chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => undefined);
  }
}

/**
 * What the popup shows for the tab: the cards the selection lists, running
 * and named jobs, and the selection itself. Built from the same select()
 * call as the toolbar count and Save.
 */
function tabView(tabId: number, scan?: Scan): DescriptorsMessage {
  const facts = scan?.facts ?? storedFacts(tabId);
  const selection = scan?.selection ?? selectFor(tabId, facts, false);
  const snapshot = router.snapshot(tabId);
  const shown = new Set<string>([...selection.cards.flatMap(card => card.ids), ...selection.ads.flatMap(card => card.ids), ...router.activeJobs(tabId)]);
  const named = router.lastNamed(tabId);
  if (named) shown.add(named);
  const descriptors = snapshot.descriptors.filter(d => shown.has(d.id));
  return {
    type: "descriptors", tabId, descriptors,
    failures: selection.failure ? [selection.failure, ...selection.shownFailures] : selection.shownFailures,
    statuses: Object.fromEntries(descriptors.flatMap(d => snapshot.statuses?.[d.id] ? [[d.id, snapshot.statuses[d.id]!]] : [])),
    selection: selectionView(selection),
    previews: selection.previews,
    page: facts?.frames.find(frame => frame.top)?.page ?? null,
    ...(facts ? { reachable: facts.reachable } : {}),
    reach: router.pageReach(tabId),
    ...(frames.frameUrl(tabId, 0) ? { pageUrl: frames.frameUrl(tabId, 0)! } : {}),
  };
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== VIEW_PORT) return;
  if (!port.sender || senderKind(port.sender as MessageSender, runtimeInfo) !== "popup") { port.disconnect(); return; }
  views.set(port, null);
  port.onMessage.addListener(raw => {
    const view = parseViewMessage(raw);
    if (view && views.has(port)) views.set(port, view.tabId);
  });
  port.onDisconnect.addListener(() => { views.delete(port); });
});

function toViews(msg: BackgroundToPopupMessage): void {
  if (!views.size) return;
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
}

// A burst of changes on one tab becomes one badge update and one message to its views.
const changedTabs = new Set<number>();
function flushChanged(): void {
  const tabIds = [...changedTabs];
  changedTabs.clear();
  for (const tabId of tabIds) {
    updateBadge(tabId);
    if (viewShows(tabId)) toViews(tabView(tabId));
  }
}

hub.on(createDiagnosticsObserver(journal, tabId => router.generation(tabId)));
hub.on(createHotkeyObserver(showHotkeyFeedback));
hub.on((event: BackgroundEvent) => {
  switch (event.type) {
    case "sources-changed":
      if (!changedTabs.size) queueMicrotask(flushChanged);
      changedTabs.add(event.tabId);
      return;
    case "job": {
      const { status, streamId, tabId } = event;
      showTransfer(tabId, streamId, status.phase === "active" ? status : null);
      if (status.phase === "active") {
        toViews({ type: "job-progress", streamId, bytesWritten: status.bytesWritten ?? 0, bytesTotal: status.bytesTotal ?? null,
          stage: status.stage ?? { kind: "starting" }, ...(status.stageSince !== undefined ? { stageSince: status.stageSince } : {}) });
        return;
      }
      // The job ended: the Referer rules it held are free again.
      rules.release(streamId);
      if (status.phase === "complete") toViews({ type: "job-complete", streamId, path: status.savedAs ?? "" });
      else if (status.phase === "cancelled") toViews({ type: "job-cancelled", streamId });
      else if (status.phase === "failed" && status.error) toViews({ type: "job-failed", streamId, error: status.error,
        ...(status.retained ? { retained: status.retained } : {}) });
      return;
    }
    case "file-recovery":
      showTransfer(event.tabId, "partial:" + event.pageUrl, event.progress);
      toViews({ type: "file-recovery-progress", tabId: event.tabId, pageUrl: event.pageUrl, progress: event.progress });
      return;
    case "file-save":
      toViews({ type: "file-save-problem", tabId: event.tabId, pageUrl: event.pageUrl, problem: event.problem });
      return;
    case "local-job": {
      const job = event.job;
      toViews({ type: "local-job", job });
      if (job.tabId === null) return;
      const terminal = job.phase === "complete" || job.phase === "failed";
      showTransfer(job.tabId, job.id, terminal ? null : localTransfer(job));
      return;
    }
    default:
      return;
  }
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** The command's shortcut as the user has it now: the page listener serves only Alt+S. */
async function shortcutIsAltS(): Promise<boolean> {
  const commands = await chrome.commands?.getAll?.().catch(() => []) ?? [];
  return isAltSShortcut(commands.find(command => command.name === "download-best")?.shortcut);
}

type TabSender = MessageSender & { readonly tab: { readonly id: number } };

function bridgeSender(sender: MessageSender): BridgeSender {
  return { url: sender.url, origin: sender.origin, tabUrl: sender.tab?.url, frameId: sender.frameId ?? 0,
    documentId: sender.documentId ?? null, documentLifecycle: sender.documentLifecycle };
}

function routingContext(tabId: number): RoutingContext {
  return { topUrl: frames.frameUrl(tabId, 0), isCurrent: (frameId, documentId) => frames.isCurrent(tabId, frameId, documentId),
    received: url => store.received(tabId, url), observedLocal: url => store.localOrigin(tabId, url) };
}

/**
 * A bridge message counts only from the document its frame shows now. The
 * page and the Referer are the sender's, never what a message claims.
 */
function shown(sender: TabSender): { readonly tabId: number; readonly frameId: number; readonly from: BridgeSender; readonly context: RoutingContext } | null {
  const tabId = sender.tab.id;
  const from = bridgeSender(sender);
  const context = routingContext(tabId);
  if (!fromShownDocument(from, context)) return null;
  frames.noteSender(tabId, from.frameId, from.documentId, sender.url ?? "");
  return { tabId, frameId: from.frameId, from, context };
}

const bridgeHandlers: BridgeHandlers = {
  "frame-active": async (msg, sender) => {
    // The frame's own announcement: only this may name a new top document (a prerendered page that was activated).
    if (sender.documentLifecycle === undefined || sender.documentLifecycle === "active") {
      frames.noteSender(sender.tab.id, sender.frameId ?? 0, sender.documentId ?? null, sender.url ?? msg.url);
    }
    return { altS: await shortcutIsAltS().catch(() => false) };
  },
  "download-best-hotkey": (_msg, sender) => {
    const at = shown(sender);
    if (!at) return;
    // The user's shortcut setting wins: a rebound or cleared command saves nothing from the page listener.
    void shortcutIsAltS().then(bound => { if (bound) void saveFromHotkey(downloadBestDeps, at.tabId); });
  },
  "observed": (msg, sender) => {
    const at = shown(sender);
    const route = at && observedCapture(msg.url, msg.requestType, at.from, at.context);
    if (route) void handleCapture(at.tabId, route.message, route.options);
  },
  "eme": (msg, sender) => {
    const at = shown(sender);
    if (at && protectElement(at.tabId, at.frameId, sender.documentId ?? null, msg.elementKey, msg.keySystem, msg.elementSrc)) changed(at.tabId);
  },
  "capture": (msg, sender) => {
    const at = shown(sender);
    if (!at) return;
    const payload = msg.payload;
    if (payload.kind === "ad-media") {
      if (payload.adUrls?.length && payload.adVia) markAds(at.tabId, payload.adUrls, payload.adVia, at.frameId);
      return;
    }
    // The MAIN world can be made to say anything: see bridge-routing.ts.
    const route = resolverCapture(payload, at.from, at.context);
    if (route) void handleCapture(at.tabId, route.message, route.options);
  },
};

/**
 * The check of a listed ad, made when the user saves it. The row was listed
 * from the browser's own answer; this is the first request savemedia makes
 * for it. Returns the checked row, or why there is none.
 */
async function checkListedAd(listed: StreamDescriptor): Promise<StreamDescriptor | JobError> {
  const { tabId, source } = listed;
  // The entry address is what is requested; where it was answered from goes along as what the browser observed.
  const address = sourceAddress(listed, "entry");
  const seen = store.originOf(tabId, urlsOf(listed));
  await handleCapture(tabId, { type: "capture", payload: { [MAIN_BRIDGE_TAG]: true, kind: "media-source", url: address, pageUrl: listed.pageUrl } }, {
    adRequested: true, priority: true, retryFailed: true, credentials: "include",
    referrerPage: seen?.referrer ?? listed.pageUrl,
    ...(source.kind === "direct-url" && source.finalUrl ? { observedUrl: source.finalUrl } : {}),
    ...(seen ? { origin: { frameId: seen.frameId, documentId: seen.documentId, via: seen.via, scope: seen.scope } } : {}),
  });
  const identity = urlsOf(listed)[0];
  const row = router.descriptors(tabId).find(d => !d.unchecked && urlsOf(d)[0] === identity);
  if (row) return row;
  return router.failures(tabId).find(failure => urlsOf(listed).includes(playlistIdentity(failure.url)))?.error
    ?? { code: "engine_job_failed", severity: "terminal", at: "direct", detail: "the check of a listed ad gave no row" };
}

// Every local-* request answers with the full status so the popup has one
// code path to render from.
async function localStatus(): Promise<PopupReply<"local-status">> {
  return { type: "local-status", ...(await localDownloader.status()) };
}

async function rescan(msg: Extract<PopupRequest, { type: "rescan" }>): Promise<DescriptorsMessage> {
  const { tabId } = msg;
  const generation = router.generation(tabId);
  hub.emit({ type: "scan", tabId, generation, outcome: { phase: "started" } });
  try {
    // The popup lists the page: every visible player's own source is checked,
    // and "Check page again" also checks again what failed on this route.
    const scan = await scanTab(downloadBestDeps, tabId, { pointer: false, thumbnails: true, retryFailed: msg.retryFailed === true, list: true });
    const reach = await reachOf(tabId, scan.facts.reachable);
    if (router.generation(tabId) === generation) router.setPageReach(tabId, reach);
    const top = scan.facts.frames.find(frame => frame.top);
    hub.emit({ type: "scan", tabId, generation, outcome: reach === "reachable"
      ? { phase: "finished", result: "scanned", publishedSources: top ? top.pageGroups.reduce((count, group) => count + group.sources.length, 0) : null,
        fileLink: !!top?.page?.fileDownload }
      : { phase: "finished", result: "unreachable", reach } });
    updateBadge(tabId);
    return tabView(tabId, scan);
  } catch {
    hub.emit({ type: "scan", tabId, generation, outcome: { phase: "finished", result: "error" } });
    return tabView(tabId);
  }
}

const popupHandlers: PopupHandlers = {
  "list": async msg => tabView(msg.tabId),
  "rescan": rescan,
  "download-page": async msg => {
    // Every click gets an answer: a save that did not start says so, with the tab as it is now.
    const stopped = await saveFromPopup(downloadBestDeps, msg.tabId, msg.pageUrl, msg.ids, { allowRepeat: msg.allowRepeat === true })
      .catch(() => "failed" as const);
    if (stopped === "unreachable") router.setPageReach(msg.tabId, await reachOf(msg.tabId, false));
    return { ...tabView(msg.tabId), ...(stopped ? { notSaved: stopped === "page-changed" ? "page-changed" as const : "could-not-start" as const } : {}) };
  },
  "download": async msg => {
    // A listed ad was never requested. The user's Save is the request to check it, and the checked row is what is saved.
    const listed = router.findDescriptor(msg.streamId);
    const checked = listed?.unchecked ? await checkListedAd(listed) : null;
    if (checked && !("id" in checked)) {
      router.recordFailure(msg.streamId, checked);
      changed(listed!.tabId);
      return { type: "download-result", outcome: "failed", error: checked };
    }
    const id = checked?.id ?? msg.streamId;
    const choice = checked ? downloadOptions(checked)[0]?.choice ?? msg.choice : msg.choice;
    const outcome = await router.startDownload(id, choice, { origin: "popup", allowRepeat: msg.allowRepeat === true });
    if (outcome.outcome === "failed") router.recordFailure(id, outcome.error);
    return outcome;
  },
  "cancel": async msg => {
    router.cancel(msg.streamId);
    return { ok: true };
  },
  "local-status": localStatus,
  "local-settings": async msg => { await localDownloader.updateSettings(msg.patch); return localStatus(); },
  "local-download": async msg => { await localDownloader.start(msg.pageUrl, msg.tabId); return localStatus(); },
  "local-cancel": async msg => { localDownloader.cancel(msg.id); return localStatus(); },
  "export-save-diagnostics": async msg => ({ ok: await exportDiagnostics(msg.tabId, msg.pageUrl).catch(() => false) }),
  "current-save-state": async msg => {
    const state = { prompt: repeatPrompt(msg.tabId, msg.pageUrl), recovery: recoveries.current(msg.tabId, msg.pageUrl) };
    if (!msg.offer) return state;
    return { ...state, saved: await savedThisSession(msg.pageUrl, msg.offer.filename).catch(() => false) };
  },
  "answer-repeat-save": msg => answerRepeat(msg.id, msg.allow),
};

chrome.runtime.onMessage.addListener(createDispatcher({ popup: popupHandlers, bridge: bridgeHandlers }, ready, runtimeInfo, logger) as never);

// ---------------------------------------------------------------------------
// Worker start
// ---------------------------------------------------------------------------

function applyStored(state: StoredState): void {
  router.importState({ tabs: state.tabs, descriptors: state.descriptors, covered: state.covered, jobs: state.jobs });
  for (const tabId of new Set([...state.media.keys(), ...state.origins.keys(), ...state.received.keys(), ...state.activity.keys(), ...state.facts.keys()])) {
    store.importTab(tabId, { media: state.media.get(tabId), origins: state.origins.get(tabId), received: state.received.get(tabId),
      activity: state.activity.get(tabId), facts: state.facts.get(tabId) });
  }
  // Which stream an address belongs to is indexed again from the rows.
  for (const tabId of state.tabs.keys()) for (const descriptor of router.descriptors(tabId)) store.indexOwners(tabId, descriptor);
  recoveries.import(state.recoveries);
  importSaves({ prompts: state.prompts,
    activeReceipts: [...state.jobs.flatMap(job => job.permit ? [job.permit.receiptKey] : []), ...recoveries.receipts()] });
  journal.import(state.diagnostics);
  rules.import(state.rules);
  importToolbar(state.toolbar, state.notices);
  for (const tabId of state.loaded) loaded.add(tabId);
  // A restored save shows on its tab's button again; the engine's next report brings its progress.
  for (const job of state.jobs) updateToolbarProgress(job.tabId, job.streamId, { stage: { kind: job.phase === "writing" ? "writing" : "starting" } });
  // So does the browser's own resume of a file, with the progress it last reported.
  for (const recovery of state.recoveries) {
    if (recovery.progress) updateToolbarProgress(recovery.tabId, "partial:" + recovery.pageUrl, recovery.progress);
  }
}

/** After the state is back: find out what the engine, the browser's downloads and the toolbar did meanwhile. */
async function reconcile(): Promise<void> {
  await engine.reconcile();
  void router.resumeWriting();
  void recoveries.resume();
  resetStaleToolbar();
  for (const { tabId } of router.storedTabs()) updateBadge(tabId);
  const holders = new Set<string>();
  for (const { tabId } of router.storedTabs()) for (const id of router.activeJobs(tabId)) holders.add(id);
  await rules.reconcile(holders);
}

void rehydrate(sessionStore, {
  openTabs: async () => new Set((await chrome.tabs.query({})).flatMap(tab => tab.id === undefined ? [] : [tab.id])),
  apply: applyStored,
  logger,
}).catch(error => logger.error("stored state could not be read", { error: String(error) }))
  .then(() => {
    resolveReady();
    return reconcile();
  }).catch(error => logger.error("reconcile failed", { error: String(error) }));

