import { useEffect, useRef, useState } from "react";
import type { StreamDescriptor } from "@savemedia/core";
import { isBackgroundToPopupMessage } from "../types/messages";
import type { BackgroundToContentMessage, PageMediaSnapshot, PopupToBackgroundMessage } from "../types/messages";
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

// Read the shipped version from the manifest so the footer never drifts from
// the package version. Optional-chained because the test chrome mock and the
// screenshot harness do not stub getManifest.
function manifestVersion(): string {
  return globalThis.chrome?.runtime?.getManifest?.().version ?? "";
}

export interface AppProps {
  readonly initialDescriptors?: readonly StreamDescriptor[];
  readonly initialStatuses?: Readonly<Record<string, JobStatus>>;
  readonly skipFetch?: boolean;
}

export function App({ initialDescriptors = [], initialStatuses = {}, skipFetch = false }: AppProps = {}) {
  const [descriptors, setDescriptors] = useState<readonly StreamDescriptor[]>(initialDescriptors);
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const tabIdRef = useRef<number | null>(null);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({ ...initialStatuses });
  const [snapshot, setSnapshot] = useState<PageMediaSnapshot | null>(null);
  const asWindow = windowTabId() !== null;

  useEffect(() => {
    if (skipFetch) return;
    const start = (id: number | null, url: string | null) => {
      tabIdRef.current = id;
      setTabId(id);
      setPageUrl(url);
      if (id === null) return;
      const msg: PopupToBackgroundMessage = { type: "list", tabId: id };
      chrome.runtime.sendMessage(msg, (response: unknown) => {
        if (isBackgroundToPopupMessage(response) && response.type === "descriptors") setDescriptors(response.descriptors);
      });
      requestSnapshot(id, setSnapshot);
    };
    const fixed = windowTabId();
    if (fixed !== null) {
      chrome.tabs.get(fixed, tab => {
        void chrome.runtime.lastError;
        start(tab?.id ?? fixed, tab?.url ?? null);
      });
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => start(tabs[0]?.id ?? null, tabs[0]?.url ?? null));
  }, [skipFetch]);

  // Players attach their <video> late; refresh the snapshot when the list changes.
  useEffect(() => {
    if (skipFetch || tabId === null || descriptors.length === 0) return;
    requestSnapshot(tabId, setSnapshot);
  }, [skipFetch, tabId, descriptors.length]);

  function openAsWindow(): void {
    if (tabId === null) return;
    const url = chrome.runtime.getURL(`src/popup/index.html?tabId=${tabId}`);
    void chrome.windows.create({ url, type: "popup", width: 440, height: 720 });
    window.close();
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
        <h2 className="px-3 pt-3 pb-1 text-[11px] font-medium text-muted">Detected</h2>
        {descriptors.length === 0 ? (
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
