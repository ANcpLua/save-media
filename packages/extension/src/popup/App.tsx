import { TransferProgress } from "./components/TransferProgress";
import { RepeatSave, useRepeatPrompt } from "./components/RepeatSave";
import { relayHost } from "../engine/relay-config";
import { useEffect, useRef, useState } from "react";
import { userMessage, type StreamDescriptor } from "@savemedia/core";
import { isBackgroundToPopupMessage } from "../types/messages";
import type { BackgroundToContentMessage, DiscoveryFailure, PageMediaSnapshot, PopupToBackgroundMessage } from "../types/messages";
import { DetectedItem, type JobStatus } from "./components/DetectedItem";
import { LocalDownloader } from "./components/LocalDownloader";
import { TechnicalDetails } from "./components/TechnicalDetails";
import { rankDescriptors } from "./preview-match";
import { isDownloadableCandidate } from "../util/downloadable";
import { downloadIssueText } from "./download-status";

// `?tabId=` is set when the popup was opened as its own window (the button
// in the header); then the active tab would be the window itself.
function windowTabId(): number | null {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("tabId");
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) ? id : null;
}

function requestSnapshot(tabId: number, pageUrl: string | null, cb: (snap: PageMediaSnapshot | null) => void): void {
  const msg: BackgroundToContentMessage = { type: "page-media-snapshot" };
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (response: unknown) => {
    void chrome.runtime.lastError;
    const snap = response && typeof response === "object" && Array.isArray((response as PageMediaSnapshot).videos)
      ? response as PageMediaSnapshot : null;
    if (!pageUrl) { cb(snap); return; }
    chrome.runtime.sendMessage({type: "current-save-state", tabId, pageUrl, offer: snap?.fileDownload}, state => {
      void chrome.runtime.lastError;
      if (state?.relay) cb({...(snap ?? {videos: [], pageTitle: ""}), relayStatus: state.relay, fileSaveProblem: null});
      else if (snap?.relayStatus?.phase === "saving") {
        const {relayStatus, ...rest} = snap;
        cb({...rest, fileSaveProblem: {filename: relayStatus.filename, stage: "file connection",
          code: "interrupted", title: "Download interrupted", body: "The transfer stopped before Chrome confirmed the save. Try again."}});
      } else if (state?.saved && snap?.fileDownload && !snap.fileSaveProblem && !snap.relayStatus) {
        cb({...snap, relayStatus: {filename: snap.fileDownload.filename, phase: "saved"}});
      } else cb(snap);
    });
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
  const onUpdated = (tabId: number, info: { status?: string }, tab: chrome.tabs.Tab): void => {
    if (tabId === current.current && info.status === "complete") start(tabId, tab.url ?? null);
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
  readonly skipFetch?: boolean;
}

export function App({ initialDescriptors = [], initialStatuses = {}, initialFailures = [], skipFetch = false }: AppProps = {}) {
  const [descriptors, setDescriptors] = useState<readonly StreamDescriptor[]>(initialDescriptors);
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const tabIdRef = useRef<number | null>(null);
  const pageUrlRef = useRef<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({ ...initialStatuses });
  const [failures, setFailures] = useState<readonly DiscoveryFailure[]>(initialFailures);
  const [scanning, setScanning] = useState(false);
  const [snapshot, setSnapshot] = useState<PageMediaSnapshot | null>(null);
  const [fileDownload, setFileDownload] = useState<"preparing" | "retrying" | "relay" | "dismissing" | "unavailable" | null>(null);
  const repeat = useRepeatPrompt(tabId, pageUrl);
  const asWindow = windowTabId() !== null;

  useEffect(() => {
    if (skipFetch) return undefined;
    const start = (id: number | null, url: string | null) => {
      if (id !== tabIdRef.current || url !== pageUrlRef.current) {
        // A different page: drop the previous tab's items at once instead of
        // showing them until the new list arrives.
        setDescriptors([]);
        setFailures([]);
        setStatuses({});
        setScanning(false);
        setSnapshot(null);
        setFileDownload(null);
      }
      tabIdRef.current = id;
      pageUrlRef.current = url;
      setTabId(id);
      setPageUrl(url);
      if (id === null) return;
      let scanFinished = false;
      const msg: PopupToBackgroundMessage = { type: "list", tabId: id };
      chrome.runtime.sendMessage(msg, (response: unknown) => {
        if (tabIdRef.current !== id || scanFinished) return;
        if (isBackgroundToPopupMessage(response) && response.type === "descriptors") {
          setDescriptors(response.descriptors);
          setFailures(response.failures ?? []);
          if (response.statuses) setStatuses({ ...response.statuses });
        }
      });
      requestSnapshot(id, url, snap => {
        if (tabIdRef.current === id) setSnapshot(snap);
      });
      // Opening/following a tab must also discover unrequested player sources.
      // Keep the existing list visible while the bounded probes finish.
      setScanning(true);
      chrome.runtime.sendMessage({ type: "rescan", tabId: id }, (response: unknown) => {
        void chrome.runtime.lastError;
        if (tabIdRef.current !== id) return;
        setScanning(false);
        if (isBackgroundToPopupMessage(response) && response.type === "descriptors") {
          scanFinished = true;
          setDescriptors(response.descriptors);
          setFailures(response.failures ?? []);
          if (response.statuses) setStatuses({ ...response.statuses });
        }
      });
    };
    const fixed = windowTabId();
    if (fixed !== null) {
      chrome.tabs.get(fixed, tab => {
        void chrome.runtime.lastError;
        start(tab?.id ?? fixed, tab?.url ?? null);
      });
      return followActiveTab(start, tabIdRef);
    }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => start(tabs[0]?.id ?? null, tabs[0]?.url ?? null));
    return undefined;
  }, [skipFetch]);

  // Players attach their <video> late; refresh the snapshot when the list changes.
  useEffect(() => {
    if (skipFetch || tabId === null || descriptors.length === 0) return;
    requestSnapshot(tabId, pageUrlRef.current, snap => {
      if (tabIdRef.current === tabId) setSnapshot(snap);
    });
  }, [skipFetch, tabId, descriptors.length]);

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
    const msg: PopupToBackgroundMessage = { type: "rescan", tabId };
    chrome.runtime.sendMessage(msg, (response: unknown) => {
      void chrome.runtime.lastError;
      if (tabIdRef.current !== requestedTabId) return;
      setScanning(false);
      if (isBackgroundToPopupMessage(response) && response.type === "descriptors") {
        setDescriptors(response.descriptors);
        setFailures(response.failures ?? []);
        if (response.statuses) setStatuses({ ...response.statuses });
      }
      requestSnapshot(requestedTabId, pageUrl, snap => {
        if (tabIdRef.current === requestedTabId) setSnapshot(snap);
      });
    });
  }

  const ranked = rankDescriptors(descriptors, snapshot);
  const filename = ranked.length === 0 && tabId !== null && pageUrl
    ? snapshot?.fileDownload?.filename ?? snapshot?.fileSaveProblem?.filename ?? snapshot?.relayStatus?.filename : undefined;
  const relayStatus = snapshot?.relayStatus?.filename === filename ? snapshot?.relayStatus : undefined;
  const startingDownload = fileDownload === "preparing" || fileDownload === "retrying" || fileDownload === "relay" || relayStatus?.phase === "saving";
  const problem = !startingDownload && filename === snapshot?.fileSaveProblem?.filename
    ? snapshot?.fileSaveProblem : null;
  const visibleFailures = failures.filter(failure => !descriptors.some(descriptor => {
    const phase = statuses[descriptor.id]?.phase;
    if (phase !== "active" && phase !== "complete") return false;
    const source = descriptor.source;
    if (source.kind === "direct-url") return source.url === failure.url || source.finalUrl === failure.url;
    return (source.kind === "media-element" ? source.elementSrc : source.manifestUrl) === failure.url;
  }));
  const confirmConnection = problem?.code === "tls_certificate_rejected" && !!problem.resourceFingerprint;
  const retryAvailable = !!problem || fileDownload === "unavailable";
  let fileAction = relayStatus?.phase === "saved" ? "Save another copy…" : retryAvailable ? "Retry download" : "Download";
  if (fileDownload === "preparing") fileAction = "Preparing download…";
  if (fileDownload === "retrying") fileAction = "Requesting a fresh download link";
  if (fileDownload === "relay" || relayStatus?.phase === "saving") fileAction = "Connecting to secure relay";
  const version = manifestVersion();

  function downloadFilePage(choice?: "retry" | "cancel"): void {
    if (tabId === null || !pageUrl || (!choice && scanning) || startingDownload || fileDownload === "dismissing") return;
    setFileDownload(choice === "cancel" ? "dismissing" : choice === "retry" ? (relayHost ? "relay" : "retrying") : "preparing");
    const msg: PopupToBackgroundMessage = choice && filename
      ? { type: "file-connection-choice", tabId, pageUrl, filename, retry: choice === "retry" }
      : { type: "download-page", tabId, pageUrl };
    chrome.runtime.sendMessage(msg, (response: unknown) => {
      void chrome.runtime.lastError;
      if (tabIdRef.current !== tabId || pageUrlRef.current !== pageUrl) return;
      if (isBackgroundToPopupMessage(response) && response.type === "descriptors") {
        setDescriptors(response.descriptors);
        setFailures(response.failures ?? []);
        if (response.statuses) setStatuses({ ...response.statuses });
        setFileDownload(null);
      } else {
        setFileDownload("unavailable");
      }
      requestSnapshot(tabId, pageUrl, snap => {
        if (snap && tabIdRef.current === tabId && pageUrlRef.current === pageUrl) {
          setSnapshot(snap);
          if (snap.relayStatus) setFileDownload(null);
        }
      });
    });
  }

  useEffect(() => {
    function listener(msg: unknown): void {
      if (!isBackgroundToPopupMessage(msg)) return;
      if (msg.type === "job-progress") {
        setStatuses(prev => ({
          ...prev,
          [msg.streamId]: {
            phase: "active",
            bytesWritten: msg.bytesWritten,
            bytesTotal: msg.bytesTotal,
            stage: msg.phase,
          },
        }));
      } else if (msg.type === "job-complete") {
        setStatuses(prev => ({ ...prev, [msg.streamId]: { phase: "complete" } }));
      } else if (msg.type === "job-failed") {
        setStatuses(prev => ({ ...prev, [msg.streamId]: { phase: "failed", error: msg.error } }));
      } else if (msg.type === "retrying-file-link" && msg.tabId === tabIdRef.current && msg.pageUrl === pageUrlRef.current) {
        setFileDownload(current => current === "preparing" ? "retrying" : current);
      } else if (msg.type === "file-relay-status" && msg.tabId === tabIdRef.current && msg.pageUrl === pageUrlRef.current) {
        setSnapshot(prev => ({...(prev ?? {videos: [], pageTitle: ""}), fileSaveProblem: null, relayStatus: msg.status}));
        setFileDownload(null);
      } else if (msg.type === "file-save-problem" && msg.tabId === tabIdRef.current && msg.pageUrl === pageUrlRef.current) {
        setSnapshot(prev => {
          if (!prev) return prev;
          if (!msg.problem) return {...prev, fileSaveProblem: null};
          const { relayStatus: _old, ...rest } = prev;
          return { ...rest, fileSaveProblem: msg.problem };
        });
      } else if (msg.type === "descriptors" && msg.tabId === tabIdRef.current) {
        setDescriptors(msg.descriptors);
        setFailures(msg.failures ?? []);
        if (msg.statuses) setStatuses({ ...msg.statuses });
      }
    }
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <main className="flex flex-col h-full bg-ink" data-window={asWindow || undefined}>
      <header className="px-3 py-3 border-b border-line flex items-center gap-2.5">
        <img
          src={globalThis.chrome?.runtime?.getURL?.("icons/icon-48.png") ?? "icons/icon-48.png"}
          alt=""
          className="w-9 h-9 rounded-lg shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">savemedia</div>
          <p className="text-[11px] text-muted leading-snug">
            Press <kbd className="text-accent font-medium">Alt+S</kbd> to save the best supported video on this page.
          </p>
        </div>
        {!asWindow && tabId !== null && (
          <button
            type="button"
            onClick={openAsWindow}
            title="Open in a resizable window"
            className="shrink-0 rounded-md bg-surface-2 hover:bg-neutral-600 text-muted hover:text-white px-2 py-1 text-[11px]"
            data-testid="open-window"
          >
            Window
          </button>
        )}
      </header>

      <section className="flex-1 overflow-y-auto">
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <h2 className="text-[11px] font-medium text-muted">Detected</h2>
          {tabId !== null && (
            <button type="button" onClick={rescan} disabled={scanning || startingDownload || !!repeat}
              className="text-[11px] text-accent disabled:text-muted">
              {scanning ? "Checking..." : "Check page again"}
            </button>
          )}
        </div>
        {repeat ? <RepeatSave prompt={repeat}/> : <>
        {ranked.length === 0 && !filename && failures.length === 0 && !scanning && (
          <div className="px-3 py-8 text-center text-muted text-xs">
            {tabId === null && !skipFetch ? "No active tab." : "No media detected on this page."}
          </div>
        )}
        {filename && (
          <ul className="px-2 pb-1">
            <li className="rounded-lg bg-surface border border-line p-3 text-xs">
              <p className="break-words font-medium">{filename}</p>
              {startingDownload ? <TransferProgress status={relayStatus?.phase === "saving" ? relayStatus : {stage: fileAction}}/> : confirmConnection ? (
                <div className="mt-2 rounded-md border border-orange-400 bg-orange-950/60 p-2.5 text-orange-50" data-testid="file-save-problem">
                  <p className="font-semibold text-red-300" role="alert">{problem.title}</p>
                  <p className="mt-1">{problem.body}</p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" onClick={() => downloadFilePage("cancel")} disabled={fileDownload === "dismissing"}
                      className="rounded-md border border-orange-300/60 px-2.5 py-1">Cancel</button>
                    <button type="button" onClick={() => downloadFilePage("retry")} disabled={fileDownload === "dismissing"}
                      className="rounded-md border border-red-400 bg-red-950 px-2.5 py-1 font-semibold text-red-100">{relayHost ? "Use secure relay" : "Download anyway"}</button>
                  </div>
                </div>
              ) : problem ? (
                <div className="mt-2" data-testid="file-save-problem">
                  <p className={`font-semibold ${downloadIssueText(problem)}`} role="status">{problem.title}</p>
                  <p className="mt-0.5 text-muted">{problem.body}</p>
                </div>
              ) : relayStatus?.phase === "saved" && !startingDownload ? (
                <p className="mt-2 text-green-300" role="status">{relayStatus.savedAs ? `Saved to Downloads · ${relayStatus.savedAs}` : "Saved earlier this browser session"}</p>
              ) : fileDownload === "unavailable" && (
                <p className="mt-2 text-orange-300" role="status">Couldn’t start the download. Try again.</p>
              )}
              {!confirmConnection && !startingDownload && <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => downloadFilePage()} disabled={scanning || startingDownload}
                  className={`hover:brightness-110 font-medium px-2.5 py-1 rounded-md ${retryAvailable ? "bg-orange-950 text-orange-200" : "bg-surface-2 text-white"}`}>
                  {fileAction}
                </button>
              </div>}
            </li>
          </ul>
        )}
        {ranked.length > 0 && (
          <ul className="px-2 pb-1 space-y-1.5">
            {ranked.map(r => (
              <DetectedItem
                key={r.descriptor.id}
                descriptor={r.descriptor}
                status={statuses[r.descriptor.id]}
                statuses={statuses}
                alternatives={r.alternatives}
                preview={r.preview}
                isMain={r.isMain}
                pageTitle={snapshot?.pageTitle ?? null}
              />
            ))}
          </ul>
        )}
        {!filename && !problem && visibleFailures.length > 0 && (descriptors.some(isDownloadableCandidate) ? (
          <details className="px-3 py-1 text-xs text-muted">
            <summary className="cursor-pointer">Unavailable sources</summary>
            <DiscoveryFailures failures={visibleFailures} />
          </details>
        ) : (
          <DiscoveryFailures failures={visibleFailures} />
        ))}
        </>}
      </section>

      <div className="border-t border-line">
        <LocalDownloader tabId={tabId} pageUrl={pageUrl} skipFetch={skipFetch} />
      </div>

      <footer className="px-3 py-2 border-t border-line text-[10px] text-muted flex items-center justify-end">
        <span>{filename ? 1 : ranked.length} detected{version && ` · v${version}`}</span>
      </footer>
    </main>
  );
}

function DiscoveryFailures({ failures }: { readonly failures: readonly DiscoveryFailure[] }) {
  return (
    <ul className="px-2 py-1 space-y-1.5" aria-label="Media check failures">
      {failures.map(({ url, error }) => {
        const { title, body, technicalDetails } = userMessage(error);
        return (
          <li key={url} className="rounded-lg border border-line bg-surface p-3 text-xs text-white">
            <p className={`font-medium ${downloadIssueText(error)}`} role="status">{title}</p>
            {technicalDetails ? <TechnicalDetails body={body} details={technicalDetails} /> : (
              <>
                <p className="text-muted mt-1">{body}</p>
                <p className="text-muted mt-1">{mediaHost(url)}</p>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function mediaHost(url: string): string {
  try { return new URL(url).host; } catch { return "Media source"; }
}
