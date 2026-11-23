import { TransferProgress } from "./components/TransferProgress";
import { describeTransfer, type TransferState } from "../util/transfer-progress";
import { RepeatSave, useRepeatPrompt } from "./components/RepeatSave";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { userMessage, type JobError, type StreamDescriptor } from "@savemedia/core";
import { parseBroadcast } from "../types/messages";
import type { DescriptorsMessage, DiscoveryFailure, FileRecoveryProgress } from "../types/messages";
import { ask, fromBackground, openView, type View } from "./request";
import type { PageReachKind } from "../util/page-reach";
import type { PageFileState, PreviewView, SelectionView } from "../types/page-facts";
import { DetectedItem, type JobStatus } from "./components/DetectedItem";
import { LocalDownloader } from "./components/LocalDownloader";
import { FailureMessage, offersRetry } from "./components/FailureMessage";
import { AnnouncerProvider, useAnnounce } from "./components/Announcer";
import { LocalOfferContext, LocalOfferSlot, type LocalOffer } from "./components/LocalOffer";
import { DiagnosticExport } from "./components/DiagnosticExport";
import { downloadOptions, isDownloadableCandidate } from "../util/downloadable";
import { expectedSize, sizeText } from "../util/expected-size";
import { SAVE_COMMAND, shortcutLabel } from "../util/shortcut";
import { ANNOUNCE, BUTTON, CONSCIENCE_LINE, COULD_NOT_START, ITEM, PAGE_CHANGED, POPUP, emptyReason, namedFilePending, pageReachText } from "../ui/text";
import { canonicalAddress, hasAddress, offersFile } from "../util/media-address";
import { select, selectionView } from "../selection/main-video";
import { emptyTabMediaState } from "../util/tab-media-state";

/** One card: the best rendition first, its other renditions after it. */
interface CardItem {
  readonly descriptor: StreamDescriptor;
  readonly alternatives: readonly StreamDescriptor[];
  readonly live: boolean;
}

/** What the page is, beyond its media: its declared file and what is known about saving it. */
interface PageState extends PageFileState {
  readonly savedThisSession?: boolean;
  readonly recovery?: FileRecoveryProgress | null;
}

/**
 * The selection for descriptors that came without one (a view rendered from
 * given data): the shared selector over them, with nothing known about the
 * page. The popup never ranks by a rule of its own.
 */
function selectionOf(descriptors: readonly StreamDescriptor[], failures: readonly DiscoveryFailure[]): SelectionView {
  return selectionView(select({ descriptors, failures, jobs: new Set(), facts: null, usePointer: false,
    media: emptyTabMediaState() }));
}

// `?tabId=` is set when the popup was opened as its own window (the button
// in the header); then the active tab would be the window itself.
function windowTabId(): number | null {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("tabId");
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) ? id : null;
}

/** Whether the page's declared file was saved this session, and Chrome's own resume of it. */
function requestSaveState(tabId: number, pageUrl: string, page: PageFileState | null,
  cb: (state: { saved?: boolean; recovery?: FileRecoveryProgress | null }) => void): void {
  ask({type: "current-save-state", tabId, pageUrl, ...(page?.fileDownload ? { offer: page.fileDownload } : {})}, state => {
    cb({ ...(state?.saved ? { saved: true } : {}), recovery: state?.recovery ?? null });
  });
}

/**
 * The detached window is a companion to whatever the user is looking at, not
 * a snapshot of the tab it was opened from: switching tabs or windows used to
 * leave it listing the old page. It follows the active tab of the focused
 * browser window, skips its own window (which has no page to inspect), and
 * re-reads the list when the followed tab finishes loading a new page.
 * Returns the cleanup for the effect.
 */
export function followActiveTab(
  start: (id: number | null, url: string | null) => void,
  current: { readonly current: number | null },
): () => void {
  let ownWindowId: number | null = null;
  chrome.windows.getCurrent(win => {
    void chrome.runtime.lastError;
    ownWindowId = win?.id ?? null;
  });

  const follow = (tab: chrome.tabs.Tab | undefined): void => {
    if (!tab?.id || tab.windowId === ownWindowId || tab.id === current.current) return;
    start(tab.id, tab.url ?? null);
  };
  const onActivated = (info: { tabId: number; windowId: number }): void => {
    if (info.windowId === ownWindowId) return;
    chrome.tabs.get(info.tabId, tab => {
      void chrome.runtime.lastError;
      follow(tab);
    });
  };
  const onFocusChanged = (windowId: number): void => {
    if (windowId === chrome.windows.WINDOW_ID_NONE || windowId === ownWindowId) return;
    chrome.tabs.query({ active: true, windowId }, tabs => follow(tabs[0]));
  };
  const onUpdated = (tabId: number, info: { status?: string; url?: string }, tab: chrome.tabs.Tab): void => {
    // A finished load, or a new address without one (a route change inside the page).
    if (tabId === current.current && (info.status === "complete" || info.url !== undefined)) start(tabId, info.url ?? tab.url ?? null);
  };

  chrome.tabs.onActivated.addListener(onActivated);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
}

// Read the shipped version from the manifest so the footer never drifts from
// the package version. Optional-chained because the test chrome mock and the
// screenshot harness do not stub getManifest.
function manifestVersion(): string {
  const manifest = globalThis.chrome?.runtime?.getManifest?.();
  return manifest?.version_name ?? manifest?.version ?? "";
}

export interface AppProps {
  readonly initialDescriptors?: readonly StreamDescriptor[];
  readonly initialStatuses?: Readonly<Record<string, JobStatus>>;
  readonly initialFailures?: readonly DiscoveryFailure[];
  readonly initialSelection?: SelectionView;
  readonly initialPage?: PageFileState | null;
  readonly skipFetch?: boolean;
}

/** The popup, with its two live regions around it. */
export function App(props: AppProps = {}) {
  return <AnnouncerProvider><Popup {...props}/></AnnouncerProvider>;
}

function withoutFragment(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

declare const __BROWSER__: "chromium" | "firefox";

/** The browser's page where a user sets an extension's keyboard shortcuts. Chromium browsers open it for an extension; Firefox has no address for it. */
const SHORTCUT_SETTINGS = typeof __BROWSER__ !== "undefined" && __BROWSER__ === "firefox" ? null : "chrome://extensions/shortcuts";

function openShortcutSettings(): void {
  if (SHORTCUT_SETTINGS) void chrome.tabs.create({ url: SHORTCUT_SETTINGS });
}

/**
 * The save command's shortcut as the browser has it now: null while it is not known, and empty when the
 * command has none. Read when the popup opens and when its window gets the focus back.
 */
function useSaveShortcut(): string | null {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    const read = (): void => {
      try {
        chrome.commands?.getAll?.(commands => {
          void chrome.runtime.lastError;
          const command = commands?.find(item => item.name === SAVE_COMMAND);
          if (command) setShortcut(command.shortcut ?? "");
        });
      } catch { /* A browser without the commands API: the header keeps the manifest's shortcut. */ }
    };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);
  return shortcut;
}

/** A stage of a job is said once, and one job is heard at most this often. */
const STAGE_ANNOUNCE_GAP_MS = 3_000;

function Popup({ initialDescriptors = [], initialStatuses = {}, initialFailures = [], initialSelection, initialPage = null, skipFetch = false }: AppProps) {
  const [descriptors, setDescriptors] = useState<readonly StreamDescriptor[]>(initialDescriptors);
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const tabIdRef = useRef<number | null>(null);
  const pageUrlRef = useRef<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({ ...initialStatuses });
  const [failures, setFailures] = useState<readonly DiscoveryFailure[]>(initialFailures);
  const [selection, setSelection] = useState<SelectionView | undefined>(initialSelection);
  const [previews, setPreviews] = useState<Readonly<Record<string, PreviewView>>>({});
  const [scanning, setScanning] = useState(false);
  const [page, setPage] = useState<PageState | null>(initialPage);
  const [fileDownload, setFileDownload] = useState<"preparing" | "unavailable" | "page-changed" | null>(null);
  const [reach, setReach] = useState<PageReachKind | null>(null);
  const viewRef = useRef<View | null>(null);
  const startRef = useRef<((id: number | null, url: string | null) => void) | null>(null);
  const repeat = useRepeatPrompt(tabId, pageUrl);
  const shortcut = useSaveShortcut();
  const asWindow = windowTabId() !== null;
  const announce = useAnnounce();
  const [localState, setLocalState] = useState<LocalOffer["state"]>("unavailable");
  const stageSaid = useRef(new Map<string, { text: string; at: number }>());

  /** What a look at the page found, said once when the look ends. */
  function announceScan(view: DescriptorsMessage): void {
    const unreadable = pageReachText(view.reach);
    if (unreadable) { announce(unreadable.title); return; }
    const count = view.selection?.cards.length ?? view.descriptors.length;
    if (count > 0) { announce(ANNOUNCE.found(count)); return; }
    const waiting = view.selection ? emptyReason(view.selection.state) : null;
    // Nothing listed because nothing could be checked is not "no media": the failures are on screen, and this says how many.
    // Nor is a page whose ads are listed below: "No media detected" would contradict the list.
    const listed = new Set(view.descriptors.map(descriptor => descriptor.id as string));
    const onlyAds = (view.selection?.ads ?? []).some(card => card.ids.some(id => listed.has(id)));
    announce(waiting ?? (view.failures?.length ? ANNOUNCE.unavailable(view.failures.length) : onlyAds ? POPUP.onlyAds : ANNOUNCE.found(0)));
  }

  /** Take the background's view of the tab as it is: one message carries everything the list shows. */
  function applyView(view: DescriptorsMessage): void {
    // A page can change its own address without loading. The list is then about the page at the new address,
    // and so is every request this popup makes from it. A fragment names a place inside the same page:
    // it changes nothing here.
    if (view.pageUrl && withoutFragment(view.pageUrl) !== withoutFragment(pageUrlRef.current ?? "")) {
      pageUrlRef.current = view.pageUrl;
      setPageUrl(view.pageUrl);
    }
    setDescriptors(view.descriptors);
    setFailures(view.failures ?? []);
    if (view.statuses) setStatuses({ ...view.statuses });
    setSelection(view.selection);
    if (view.reach !== undefined) setReach(view.reach);
    // A view made without a fresh look at the page has no thumbnails: keep the ones already shown.
    setPreviews(previous => Object.fromEntries(Object.entries(view.previews ?? {}).map(([id, preview]) =>
      [id, { ...preview, thumbnail: preview.thumbnail ?? previous[id]?.thumbnail ?? null }])));
    if (view.page !== undefined) {
      setPage(previous => view.page ? { ...(previous ?? {}), ...view.page } : null);
      const id = view.tabId;
      const url = pageUrlRef.current;
      if (view.page && url) requestSaveState(id, url, view.page, state => {
        if (tabIdRef.current !== id || pageUrlRef.current !== url) return;
        setPage(previous => previous && { ...previous, ...(state.saved ? { savedThisSession: true } : {}), recovery: state.recovery ?? null });
      });
    }
  }

  useEffect(() => {
    if (skipFetch) return undefined;
    const start = (id: number | null, url: string | null) => {
      if (id !== tabIdRef.current || url !== pageUrlRef.current) {
        // A different page: drop the previous tab's items at once instead of
        // showing them until the new list arrives.
        setDescriptors([]);
        setFailures([]);
        setStatuses({});
        setSelection(undefined);
        setPreviews({});
        setScanning(false);
        setPage(null);
        setFileDownload(null);
        setReach(null);
      }
      tabIdRef.current = id;
      pageUrlRef.current = url;
      setTabId(id);
      setPageUrl(url);
      // The background sends this tab's list only to popups that show it.
      viewRef.current?.show(id);
      if (id === null) return;
      let scanFinished = false;
      ask({ type: "list", tabId: id }, view => {
        if (tabIdRef.current !== id || scanFinished) return;
        if (view) applyView(view);
      });
      // Opening/following a tab must also discover unrequested player sources.
      // Keep the existing list visible while the bounded probes finish.
      setScanning(true);
      ask({ type: "rescan", tabId: id }, view => {
        if (tabIdRef.current !== id) return;
        setScanning(false);
        // A request that failed keeps the list as it is.
        if (view) {
          scanFinished = true;
          applyView(view);
          announceScan(view);
        }
      });
    };
    startRef.current = start;
    const view = openView();
    viewRef.current = view;
    const closeView = (): void => { view.close(); viewRef.current = null; };
    const fixed = windowTabId();
    if (fixed !== null) {
      chrome.tabs.get(fixed, tab => {
        void chrome.runtime.lastError;
        start(tab?.id ?? fixed, tab?.url ?? null);
      });
      const unfollow = followActiveTab(start, tabIdRef);
      return () => { unfollow(); closeView(); };
    }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => start(tabs[0]?.id ?? null, tabs[0]?.url ?? null));
    return closeView;
  }, [skipFetch]);

  // A page that is loading, or was just told to reload, is looked at again when its load ends.
  // The detached window already follows its tab's loads.
  const awaitingLoad = reach === "loading" || reach === "needs-reload" || reach === "load-failed";
  useEffect(() => {
    if (!awaitingLoad || tabId === null || asWindow) return undefined;
    const onUpdated = (id: number, info: { status?: string }, tab: chrome.tabs.Tab): void => {
      if (id === tabId && info.status === "complete") startRef.current?.(id, tab.url ?? null);
    };
    chrome.tabs.onUpdated?.addListener(onUpdated);
    return () => chrome.tabs.onUpdated?.removeListener?.(onUpdated);
  }, [awaitingLoad, tabId, asWindow]);

  function reloadPage(): void {
    if (tabId === null) return;
    void chrome.tabs.reload(tabId);
  }

  function openAsWindow(): void {
    if (tabId === null) return;
    const url = chrome.runtime.getURL(`src/popup/index.html?tabId=${tabId}`);
    void chrome.windows.create({ url, type: "popup", width: 440, height: 720 });
    window.close();
  }

  function rescan(): void {
    if (tabId === null || scanning) return;
    const requestedTabId = tabId;
    setScanning(true);
    // The user asked again: sources that failed on this page are checked again too.
    ask({ type: "rescan", tabId, retryFailed: true }, view => {
      if (tabIdRef.current !== requestedTabId) return;
      setScanning(false);
      if (view) {
        applyView(view);
        announceScan(view);
      }
    });
  }

  // The cards and the main video are the background's selection. A view
  // rendered from given data runs the same selector over it.
  const shown = useMemo(() => selection ?? selectionOf(descriptors, failures), [selection, descriptors, failures]);
  const cards = useMemo<CardItem[]>(() => {
    const byId = new Map(descriptors.map(d => [d.id as string, d]));
    return shown.cards.flatMap(card => {
      const [descriptor, ...alternatives] = card.ids.flatMap(id => byId.get(id) ?? []);
      return descriptor ? [{ descriptor, alternatives, live: card.live }] : [];
    });
  }, [shown, descriptors]);
  const adItems = useMemo<CardItem[]>(() => {
    const byId = new Map(descriptors.map(d => [d.id as string, d]));
    return (shown.ads ?? []).flatMap(card => {
      const [descriptor, ...alternatives] = card.ids.flatMap(id => byId.get(id) ?? []);
      return descriptor ? [{ descriptor, alternatives, live: card.live }] : [];
    });
  }, [shown, descriptors]);
  const filename = tabId !== null && pageUrl ? page?.fileDownload?.filename ?? page?.fileSaveProblem?.filename : undefined;
  const startingDownload = fileDownload === "preparing" || !!page?.recovery;
  const problem = !startingDownload && filename === page?.fileSaveProblem?.filename ? page?.fileSaveProblem : null;
  const best = descriptors.find(d => d.id === shown.mainId && isDownloadableCandidate(d));
  const namedJob = filename ? [...descriptors].reverse().find(d => d.pageUrl === pageUrl && statuses[d.id]?.fileName === filename) : undefined;
  const primarySource = filename ? namedJob : descriptors.find(d => d.id === shown.mainId);
  const primary = primarySource ? cards.find(item => item.descriptor.id === primarySource.id
    || item.alternatives.some(d => d.id === primarySource.id)) : undefined;
  const showFileCard = !!filename && (!primary || !!problem || (startingDownload && namedJob && statuses[namedJob.id]?.phase !== "active"));
  // A page's declared file never hides what the page loaded: the other cards stay listed below it.
  // The declared file itself is the file row, not a second card.
  const offeredAddress = page?.fileDownload?.url;
  const offered = showFileCard ? offeredAddress : undefined;
  const isOffered = (item: CardItem): boolean => !!offered && [item.descriptor, ...item.alternatives].some(d => offersFile(d, offered));
  const otherItems = cards.filter(item => item !== primary && !isOffered(item));
  const visibleFailures = failures.filter(failure => !descriptors.some(descriptor => {
    const phase = statuses[descriptor.id]?.phase;
    return (phase === "active" || phase === "complete") && hasAddress(descriptor, failure.url);
  }));
  // The file row reports the named file's own failure. What else failed on the page stays listed.
  const displayedFailures = filename && offeredAddress ? visibleFailures.filter(failure => canonicalAddress(failure.url) !== canonicalAddress(offeredAddress))
    : visibleFailures;
  // A Save that did not get as far as a save: why, in the place the save's own failure would show.
  const startFailure = fileDownload === "unavailable" ? COULD_NOT_START : fileDownload === "page-changed" ? PAGE_CHANGED : null;
  const fileFailure = problem ? (problem.error ? userMessage(problem.error) : COULD_NOT_START) : startFailure;
  const fileRetained = namedJob ? statuses[namedJob.id]?.retained : undefined;
  const retryAvailable = !!fileFailure && offersRetry(fileFailure, fileRetained);
  const fileAction = retryAvailable ? BUTTON.retry : page?.savedThisSession ? BUTTON.again : BUTTON.save;
  // The browser's own resume reports its progress; a save that is starting has none yet.
  const preparing: TransferState = page?.recovery ?? { stage: { kind: "starting" } };
  const emptyHint = emptyReason(shown.state);
  const reachText = pageReachText(reach);
  const version = manifestVersion();
  // The size of the file row's file, when the server stated it or the stream implies it.
  const fileSource = namedJob ?? best;
  const fileSize = fileSource ? expectedSize(fileSource, downloadOptions(fileSource)[0]?.variant ?? fileSource.variants[0]) : null;
  // "You can close this popup" is said once, under the first save that runs.
  const firstRunning = cards.find(item => [item.descriptor, ...item.alternatives].some(d => statuses[d.id]?.phase === "active"));

  function downloadFilePage(allowRepeat = false): void {
    if (tabId === null || !pageUrl || startingDownload || tabIdRef.current !== tabId || pageUrlRef.current !== pageUrl) return;
    setFileDownload("preparing");
    // The card as it is shown: Save starts this one, also when the page has moved on since.
    const ids = primary ? [primary.descriptor, ...primary.alternatives].map(d => d.id) : [];
    ask({ type: "download-page", tabId, pageUrl, ...(ids.length ? { ids } : {}), ...(allowRepeat ? { allowRepeat } : {}) }, view => {
      // The page's address may have changed meanwhile: the answer is still this tab's.
      if (tabIdRef.current !== tabId) return;
      if (view) applyView(view);
      // No answer, or a save that did not start: the click is never left without a word.
      const stopped = !view || view.notSaved === "could-not-start" ? "unavailable" : view.notSaved === "page-changed" ? "page-changed" : null;
      setFileDownload(stopped);
      if (stopped) announce(ANNOUNCE.failure(stopped === "page-changed" ? PAGE_CHANGED : COULD_NOT_START), "assertive");
    });
  }

  const savePageLocally = useCallback((): void => {
    const id = tabIdRef.current;
    const url = pageUrlRef.current;
    if (url) ask({ type: "local-download", tabId: id, pageUrl: url }, () => undefined);
  }, []);
  const localOffer = useMemo<LocalOffer>(() => ({ state: localState, save: savePageLocally }), [localState, savePageLocally]);

  useEffect(() => {
    function listener(raw: unknown, sender?: chrome.runtime.MessageSender): void {
      // Only the background's messages count: a page's content script can send anything.
      const msg = fromBackground(sender) ? parseBroadcast(raw) : null;
      if (!msg) return;
      // Job updates reach every open popup. Only the saves of the tab this popup shows are said aloud.
      const mine = "streamId" in msg && (shownIds.current.has(msg.streamId) || msg.streamId === `discovery:${tabIdRef.current}`);
      if (msg.type === "job-progress") {
        const { announce: stageText } = describeTransfer({ stage: msg.stage });
        const said = stageSaid.current.get(msg.streamId);
        if (mine && stageText && said?.text !== stageText && Date.now() - (said?.at ?? 0) >= STAGE_ANNOUNCE_GAP_MS) {
          stageSaid.current.set(msg.streamId, { text: stageText, at: Date.now() });
          announce(stageText);
        }
        setStatuses(prev => {
          const { error: _error, retained: _retained, savedAs: _savedAs, stageSince: _since, ...earlier } = prev[msg.streamId] ?? {};
          return { ...prev, [msg.streamId]: { ...earlier, phase: "active", bytesWritten: msg.bytesWritten, bytesTotal: msg.bytesTotal,
            stage: msg.stage, ...(msg.stageSince !== undefined ? { stageSince: msg.stageSince } : {}) } };
        });
      } else if (msg.type === "job-complete") {
        stageSaid.current.delete(msg.streamId);
        if (mine) announce(ANNOUNCE.saved(msg.path.split(/[\\/]/).pop() || undefined));
        setStatuses(prev => ({ ...prev, [msg.streamId]: { ...prev[msg.streamId], phase: "complete", savedAs: msg.path } }));
      } else if (msg.type === "job-cancelled") {
        // The user's own cancel: the card goes back to Save. Nothing failed.
        stageSaid.current.delete(msg.streamId);
        if (mine) announce(ANNOUNCE.cancelled);
        setStatuses(prev => {
          const { error: _error, retained: _retained, stage: _stage, stageSince: _since, bytesWritten: _written, bytesTotal: _total, ...earlier } = prev[msg.streamId] ?? {};
          return { ...prev, [msg.streamId]: { ...earlier, phase: "cancelled" } };
        });
      } else if (msg.type === "job-failed") {
        stageSaid.current.delete(msg.streamId);
        if (mine) announce(ANNOUNCE.failure(userMessage(msg.error)), "assertive");
        // Each failure message states the bytes it kept: none when it names none.
        setStatuses(prev => {
          const { retained: _earlier, ...status } = prev[msg.streamId] ?? {};
          return { ...prev, [msg.streamId]: { ...status, phase: "failed", error: msg.error, ...(msg.retained ? { retained: msg.retained } : {}) } };
        });
      } else if (msg.type === "file-recovery-progress" && msg.tabId === tabIdRef.current && msg.pageUrl === pageUrlRef.current) {
        setPage(prev => prev && {...prev, recovery: msg.progress});
        if (!msg.progress) requestSaveState(msg.tabId, msg.pageUrl, pageRef.current, state => {
          if (msg.tabId !== tabIdRef.current || msg.pageUrl !== pageUrlRef.current) return;
          setPage(prev => prev && { ...prev, ...(state.saved ? { savedThisSession: true } : {}), recovery: state.recovery ?? null });
        });
      } else if (msg.type === "file-save-problem" && msg.tabId === tabIdRef.current && msg.pageUrl === pageUrlRef.current) {
        if (msg.problem) announce(ANNOUNCE.failure(msg.problem.error ? userMessage(msg.problem.error) : COULD_NOT_START), "assertive");
        setPage(prev => prev && { ...prev, fileSaveProblem: msg.problem });
      } else if (msg.type === "descriptors" && msg.tabId === tabIdRef.current) {
        applyView(msg);
      }
    }
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [announce]);

  const pageRef = useRef<PageState | null>(page);
  pageRef.current = page;
  /** The streams this popup lists: what a job message must name to be this tab's. */
  const shownIds = useRef<ReadonlySet<string>>(new Set());
  shownIds.current = new Set(descriptors.map(d => d.id as string));

  function card(item: CardItem, primaryCard = false, ad = false) {
    // Saving "the page's main video" asks the page's own script first. While it does not answer, the card's own
    // Save starts the listed stream, as every other card does.
    const allowPageSave = primaryCard && tabId !== null && !!pageUrl && (reach === null || reach === "reachable");
    return <DetectedItem
      key={item.descriptor.id}
      descriptor={item.descriptor}
      status={statuses[item.descriptor.id]}
      statuses={statuses}
      alternatives={item.alternatives}
      preview={[item.descriptor, ...item.alternatives].map(d => previews[d.id]).find(preview => preview !== undefined) ?? null}
      isMain={primaryCard && shown.elementMain}
      ad={ad}
      live={item.live}
      // The page's title is the name of the file it names. What is listed is not that file, so it is not called by it.
      pageTitle={shown.namedPending ? null : page?.title ?? null}
      onListingExpired={rescan}
      originalName={primaryCard ? filename ?? shown.mainName ?? undefined : undefined}
      onSaveBest={allowPageSave ? downloadFilePage : undefined}
      preparing={primaryCard && startingDownload ? preparing : undefined}
      startFailure={primaryCard ? startFailure ?? undefined : undefined}
      closeHint={item === firstRunning}
    />;
  }

  const blank = cards.length === 0 && !filename && failures.length === 0 && !startingDownload && !(reachText && reach !== "loading");

  return (
    <LocalOfferContext.Provider value={localOffer}>
    <main className="flex flex-col h-full bg-ink" data-window={asWindow || undefined}>
      <header className="px-3 py-3 border-b border-line flex items-center gap-2.5">
        <img
          src={globalThis.chrome?.runtime?.getURL?.("icons/icon-48.png") ?? "icons/icon-48.png"}
          alt=""
          className="w-9 h-9 rounded-lg shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold leading-tight">{POPUP.name}</h1>
          {shortcut === "" ? (
            // The browser gave the command no key (another extension holds it) or the user cleared it:
            // the header never promises a key that does nothing.
            <p className="text-[11px] text-muted leading-snug" data-testid="shortcut-missing">
              {POPUP.shortcutMissing}{" "}
              {SHORTCUT_SETTINGS && (
                <button type="button" onClick={openShortcutSettings} className="text-accent underline" data-testid="set-shortcut">{POPUP.setShortcut}</button>
              )}
            </p>
          ) : (
            <p className="text-[11px] text-muted leading-snug" data-testid="shortcut-hint">
              <kbd className="text-accent font-medium">{shortcut === null ? "Alt+S" : shortcutLabel(shortcut)}</kbd> {POPUP.shortcutHint}
            </p>
          )}
        </div>
        {!asWindow && tabId !== null && (
          <button
            type="button"
            onClick={openAsWindow}
            title={POPUP.windowTitle}
            className="shrink-0 rounded-md bg-surface-2 hover:bg-neutral-600 text-muted hover:text-white px-2 py-1 text-[11px]"
            data-testid="open-window"
          >
            {POPUP.window}
          </button>
        )}
      </header>

      <section className="flex-1 overflow-y-auto" aria-busy={scanning} data-testid="media-list">
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <h2 className="text-[11px] font-medium text-muted">{POPUP.listHeading}</h2>
          {tabId !== null && (
            <button type="button" onClick={rescan} disabled={scanning || startingDownload || !!repeat}
              className="text-[11px] text-accent disabled:text-muted" data-testid="rescan">
              {scanning ? POPUP.rescanning : POPUP.rescan}
            </button>
          )}
        </div>
        {repeat ? <RepeatSave prompt={repeat}/> : <>
        {reachText && reach !== "loading" && (
          <div className="mx-3 mb-2 rounded-lg border border-line bg-surface p-3 text-xs" data-testid="page-reach">
            <p className="font-medium">{reachText.title}</p>
            {reachText.body && <p className="mt-1 text-muted">{reachText.body}</p>}
            {(reach === "needs-reload" || reach === "load-failed") && (
              <button type="button" onClick={reloadPage} className="mt-2 rounded bg-surface-2 px-2 py-1 font-medium">{POPUP.reloadPage}</button>
            )}
          </div>
        )}
        {blank && scanning && (
          // The first look at a page can take a moment: say that it is under way instead of showing nothing.
          <div className="px-3 py-8 text-center text-muted text-xs" data-testid="page-loading">
            <p>{POPUP.loading}</p>
            <div className="mx-auto mt-2 h-1 w-24 overflow-hidden rounded bg-surface-2" aria-hidden="true">
              <div className="h-full w-1/3 rounded bg-accent animate-pulse"/>
            </div>
          </div>
        )}
        {blank && !scanning && (
          <div className="px-3 py-8 text-center text-muted text-xs">
            {tabId === null && !skipFetch ? <p>{POPUP.noTab}</p>
              : reach === "loading" && reachText ? <p data-testid="page-hint">{reachText.title}</p>
              : emptyHint ? <p data-testid="page-hint">{emptyHint}</p>
              // The Ads group below holds something to save: the list is not empty, and "start it" is no advice for it.
              : adItems.length > 0 ? <p data-testid="page-only-ads">{POPUP.onlyAds}</p>
                : <>
                  <p data-testid="page-empty">{POPUP.empty}</p>
                  <p className="mt-1" data-testid="page-empty-hint">{POPUP.emptyHint}</p>
                </>}
          </div>
        )}
        {/* The reason nothing is offered comes first, also next to what could not be checked: a failed source
            the page's data names never stands in for "the page has not loaded the video yet". */}
        {!blank && !primary && !filename && emptyHint && (cards.length > 0 || failures.length > 0) && (
          <p className="px-3 pb-2 text-xs text-muted" data-testid="page-hint">{emptyHint}</p>
        )}
        {showFileCard && (
          <ul className="px-2 pb-1">
            <li className="rounded-lg bg-surface border border-line p-3 text-xs" data-testid="file-card">
              <p className="break-words font-medium">
                <span data-testid="file-name">{filename}</span>
                {fileSize && <span className="text-muted font-normal" data-testid="expected-size" title={fileSize.exact ? ITEM.exactTitle : ITEM.estimateTitle}> · {sizeText(fileSize)}</span>}
              </p>
              {startingDownload ? <TransferProgress status={preparing}/> : problem && fileFailure ? (
                <FailureMessage className="mt-2" testId="file-save-problem" message={fileFailure} retained={fileRetained}
                  extra={problem.error ? <LocalOfferSlot error={problem.error}/> : undefined}/>
              ) : fileFailure ? (
                <FailureMessage className="mt-2" testId="could-not-start" message={fileFailure}/>
              ) : page?.savedThisSession && (
                <p className="mt-2 text-green-300" data-testid="saved-earlier">{POPUP.savedEarlier}</p>
              )}
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => downloadFilePage(fileAction === BUTTON.again)} disabled={startingDownload}
                  className={`hover:brightness-110 disabled:opacity-60 font-medium px-2.5 py-1 rounded-md ${startingDownload ? "bg-surface-2 text-white"
                    : retryAvailable ? "bg-orange-950 text-orange-200" : "bg-emerald-400 text-ink"}`} data-testid="file-action">
                  {startingDownload ? BUTTON.preparing : fileAction}
                </button>
              </div>
            </li>
          </ul>
        )}
        {!showFileCard && primary && <ul className="px-2 pb-1">{card(primary, true)}</ul>}
        {!showFileCard && primary && shown.namedPending && (
          // The page names a file and plays something else: the card above is not that file, and nothing says it is.
          <p className="px-3 pb-2 text-xs text-muted" data-testid="named-file-pending">{namedFilePending(shown.namedPending)}</p>
        )}
        {otherItems.length > 0 && (primary || showFileCard ? (
          // A page's main video or named file never hides what else the page loaded: it is one click away.
          <details className="px-2 pb-1 text-xs" data-testid="other-media">
            <summary className="cursor-pointer px-1 py-1 text-muted">{POPUP.otherMedia(otherItems.length)}</summary>
            <ul className="space-y-1.5">{otherItems.map(item => card(item))}</ul>
          </details>
        ) : <ul className="px-2 pb-1 space-y-1.5">{otherItems.map(item => card(item))}</ul>)}
        {adItems.length > 0 && (
          // What the page's ad responses named and the browser loaded: last, closed, and never counted or picked. Each can still be saved.
          <details className="px-2 pb-1 text-xs" data-testid="ads">
            <summary className="cursor-pointer px-1 py-1 text-muted">{POPUP.ads(adItems.length)}</summary>
            <ul className="space-y-1.5">{adItems.map(item => card(item, false, true))}</ul>
          </details>
        )}
        {!startingDownload && displayedFailures.length > 0 && (best || filename || emptyHint ? (
          <details className="px-3 py-1 text-xs text-muted" data-testid="unavailable-sources">
            <summary className="cursor-pointer">{POPUP.unavailableSources(displayedFailures.length)}</summary>
            <DiscoveryFailures failures={displayedFailures} />
          </details>
        ) : (
          <DiscoveryFailures failures={displayedFailures} />
        ))}
        {!filename && !primary && startingDownload && (
          <div className="px-3 pb-2"><TransferProgress status={preparing} /></div>
        )}
        </>}
      </section>

      <div className="border-t border-line">
        <LocalDownloader tabId={tabId} pageUrl={pageUrl} skipFetch={skipFetch} onAvailability={setLocalState} />
      </div>

      <footer className="px-3 py-2 border-t border-line text-[10px] text-muted">
        {/* The one appeal to the user's conscience: static, said once, never repeated on a failure or in a toast. */}
        <p className="mb-1" data-testid="conscience-line">{CONSCIENCE_LINE}</p>
        <div className="flex items-center justify-between gap-2">
          <DiagnosticExport key={`${tabId}:${pageUrl}`} tabId={tabId} pageUrl={pageUrl}/>
          {version && <span data-testid="version">v{version}</span>}
        </div>
      </footer>
    </main>
    </LocalOfferContext.Provider>
  );
}

function DiscoveryFailures({ failures }: { readonly failures: readonly DiscoveryFailure[] }) {
  return (
    <ul className="px-2 py-1 space-y-1.5" aria-label={POPUP.unavailableSourcesLabel}>
      {failures.map(({ url, error }) => (
        <li key={url} className="rounded-lg border border-line bg-surface p-3 text-xs text-white">
          <FailureMessage testId="discovery-failure" message={userMessage(withServer(error, url))} extra={<LocalOfferSlot error={error}/>}/>
        </li>
      ))}
    </ul>
  );
}

/** A failure that names no server takes the host of the address that was checked, for its Technical details. */
function withServer(error: JobError, url: string): JobError {
  if (error.code !== "unexpected_media_response" || error.host) return error;
  try { return { ...error, host: new URL(url).host }; } catch { return error; }
}
