import { useEffect, useRef, useState } from "react";
import type { StreamDescriptor } from "@savemedia/core";
import { isBackgroundToPopupMessage } from "../types/messages";
import type { PopupToBackgroundMessage } from "../types/messages";
import { DetectedItem, type JobStatus } from "./components/DetectedItem";
import { StreamInfoBadges } from "./components/StreamInfoBadges";

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
  const tabIdRef = useRef<number | null>(null);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({ ...initialStatuses });

  useEffect(() => {
    if (skipFetch) return;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const id = tabs[0]?.id ?? null;
      tabIdRef.current = id;
      setTabId(id);
      if (id === null) return;
      const msg: PopupToBackgroundMessage = { type: "list", tabId: id };
      chrome.runtime.sendMessage(msg, (response: unknown) => {
        if (isBackgroundToPopupMessage(response) && response.type === "descriptors") setDescriptors(response.descriptors);
      });
    });
  }, [skipFetch]);

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
    <main className="flex flex-col h-full bg-ink">
      <header className="px-3 py-3 border-b border-line flex items-center gap-2.5">
        <img
          src={globalThis.chrome?.runtime?.getURL?.("icons/icon-48.png") ?? "icons/icon-48.png"}
          alt=""
          className="w-9 h-9 rounded-lg shrink-0"
        />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">savemedia</div>
          <p className="text-[11px] text-muted leading-snug">
            Press <kbd className="text-accent font-medium">Alt+S</kbd> to save the best supported video on this page.
          </p>
        </div>
      </header>

      <section className="flex-1 overflow-y-auto">
        <h2 className="px-3 pt-3 pb-1 text-[11px] font-medium text-muted">Detected</h2>
        {descriptors.length === 0 ? (
          <div className="px-3 py-8 text-center text-muted text-xs">
            {tabId === null && !skipFetch ? "No active tab." : "No media detected on this page."}
          </div>
        ) : (
          <ul className="px-2 pb-1 space-y-1.5">
            {descriptors.map(d => (
              <DetectedItem key={d.id} descriptor={d} status={statuses[d.id]} />
            ))}
          </ul>
        )}
      </section>

      <div className="border-t border-line">
        <StreamInfoBadges />
      </div>

      <footer className="px-3 py-2 border-t border-line text-[10px] text-muted flex items-center justify-between">
        <button
          aria-label="Settings"
          className="inline-flex items-center gap-1 hover:text-neutral-200"
          onClick={() => chrome.runtime.openOptionsPage?.()}
        >
          <span aria-hidden="true">⚙</span> Settings
        </button>
        <span>{descriptors.length} detected{version && ` · v${version}`}</span>
      </footer>
    </main>
  );
}
