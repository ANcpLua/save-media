import { useEffect, useRef, useState } from "react";
import { userMessage, type StreamDescriptor } from "@savemedia/core";
import { isBackgroundToPopupMessage } from "../types/messages";
import type { BackgroundToContentMessage, DiscoveryFailure, PageMediaSnapshot, PopupToBackgroundMessage } from "../types/messages";
import { DetectedItem, type JobStatus } from "./components/DetectedItem";
import { LocalDownloader } from "./components/LocalDownloader";
import { rankDescriptors } from "./preview-match";

// `?tabId=` is set when the popup was opened as its own window (the button
// in the header); then the active tab would be the window itself.
function windowTabId(): number | null {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("tabId");
  const id = raw === null ? NaN : Number(raw);
  return Number.isInteger(id) ? id : null;
}

function requestSnapshot(tabId: number, cb: (snap: PageMediaSnapshot | null) => void): void {
  const msg: BackgroundToContentMessage = { type: "page-media-snapshot" };
  chrome.tabs.sendMessage(tabId, msg, (response: unknown) => {
    void chrome.runtime.lastError;
    cb(response && typeof response === "object" && Array.isArray((response as PageMediaSnapshot).videos) ? response as PageMediaSnapshot : null);
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
  return globalThis.chrome?.runtime?.getManifest?.().version ?? "";
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
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({ ...initialStatuses });
  const [failures, setFailures] = useState<readonly DiscoveryFailure[]>(initialFailures);
  const [scanning, setScanning] = useState(false);
  const [snapshot, setSnapshot] = useState<PageMediaSnapshot | null>(null);
  const asWindow = windowTabId() !== null;

  useEffect(() => {
    if (skipFetch) return undefined;
    const start = (id: number | null, url: string | null) => {
      if (id !== tabIdRef.current) {
        // A different page: drop the previous tab's items at once instead of
        // showing them until the new list arrives.
        setDescriptors([]);
        setFailures([]);
        setStatuses({});
        setScanning(false);
        setSnapshot(null);
      }
      tabIdRef.current = id;
      setTabId(id);
      setPageUrl(url);
      if (id === null) return;
      const msg: PopupToBackgroundMessage = { type: "list", tabId: id };
      chrome.runtime.sendMessage(msg, (response: unknown) => {
        if (tabIdRef.current !== id) return;
        if (isBackgroundToPopupMessage(response) && response.type === "descriptors") {
          setDescriptors(response.descriptors);
          setFailures(response.failures ?? []);
          if (response.statuses) setStatuses({ ...response.statuses });
        }
      });
      requestSnapshot(id, snap => {
        if (tabIdRef.current === id) setSnapshot(snap);
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
    requestSnapshot(tabId, snap => {
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
      requestSnapshot(requestedTabId, snap => {
        if (tabIdRef.current === requestedTabId) setSnapshot(snap);
      });
    });
  }

  const ranked = rankDescriptors(descriptors, snapshot);

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
      } else if (msg.type === "descriptors" && msg.tabId === tabIdRef.current) {
        setDescriptors(msg.descriptors);
        setFailures(msg.failures ?? []);
        if (msg.statuses) setStatuses({ ...msg.statuses });
      }
    }
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const version = manifestVersion();

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
            <button type="button" onClick={rescan} disabled={scanning}
              className="text-[11px] text-accent disabled:text-muted">
              {scanning ? "Checking..." : "Check page again"}
            </button>
          )}
        </div>
        {failures.length > 0 && (
          <ul className="px-2 py-1 space-y-1.5" aria-label="Media check failures">
            {failures.map(failure => (
              <li key={failure.url} className="rounded-lg border border-red-900/40 bg-surface p-3 text-xs" role="status">
                <p className="font-medium text-red-400">{userMessage(failure.error).title}</p>
                <p className="text-muted mt-1">{userMessage(failure.error).body}</p>
                <p className="text-muted mt-1">{mediaHost(failure.url)}</p>
              </li>
            ))}
          </ul>
        )}
        {descriptors.length === 0 && failures.length === 0 ? (
          <div className="px-3 py-8 text-center text-muted text-xs">
            {tabId === null && !skipFetch ? "No active tab." : "No media detected on this page."}
          </div>
        ) : (
          <ul className="px-2 pb-1 space-y-1.5">
            {ranked.map(r => (
              <DetectedItem
                key={r.descriptor.id}
                descriptor={r.descriptor}
                status={statuses[r.descriptor.id]}
                preview={r.preview}
                isMain={r.isMain}
                pageTitle={snapshot?.pageTitle ?? null}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="border-t border-line">
        <LocalDownloader tabId={tabId} pageUrl={pageUrl} skipFetch={skipFetch} />
      </div>

      <footer className="px-3 py-2 border-t border-line text-[10px] text-muted flex items-center justify-end">
        <span>{descriptors.length} detected{version && ` · v${version}`}</span>
      </footer>
    </main>
  );
}

function mediaHost(url: string): string {
  try { return new URL(url).host; } catch { return "Media source"; }
}
