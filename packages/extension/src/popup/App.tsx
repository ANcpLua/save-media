import { useEffect, useState } from "react";
import type { StreamDescriptor } from "@savemedia/core";
import type { BackgroundToPopupMessage, PopupToBackgroundMessage } from "../types/messages";
import { DetectedItem, type JobStatus } from "./components/DetectedItem";

export interface AppProps {
  readonly initialDescriptors?: readonly StreamDescriptor[];
  readonly initialStatuses?: Readonly<Record<string, JobStatus>>;
  readonly skipFetch?: boolean;
}

export function App({ initialDescriptors = [], initialStatuses = {}, skipFetch = false }: AppProps = {}) {
  const [descriptors, setDescriptors] = useState<readonly StreamDescriptor[]>(initialDescriptors);
  const [tabId, setTabId] = useState<number | null>(null);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({ ...initialStatuses });

  useEffect(() => {
    if (skipFetch) return;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const id = tabs[0]?.id ?? null;
      setTabId(id);
      if (id === null) return;
      const msg: PopupToBackgroundMessage = { type: "list", tabId: id };
      chrome.runtime.sendMessage(msg, (response: BackgroundToPopupMessage | undefined) => {
        if (response?.type === "descriptors") setDescriptors(response.descriptors);
      });
    });
  }, [skipFetch]);

  useEffect(() => {
    function listener(msg: BackgroundToPopupMessage): void {
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
      }
    }
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <main className="flex flex-col h-full">
      <header className="px-3 py-2 border-b border-neutral-800 flex items-center justify-between">
        <span className="text-sm font-semibold">savemedia</span>
        <button
          aria-label="Settings"
          className="text-neutral-500 hover:text-neutral-300 text-xs"
          onClick={() => chrome.runtime.openOptionsPage?.()}
        >
          ⚙
        </button>
      </header>
      <section className="flex-1 overflow-y-auto">
        {descriptors.length === 0 ? (
          <div className="p-6 text-center text-neutral-500 text-xs">
            {tabId === null && !skipFetch ? "No active tab." : "No media detected on this page."}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {descriptors.map(d => (
              <DetectedItem key={d.id} descriptor={d} status={statuses[d.id]} />
            ))}
          </ul>
        )}
      </section>
      <footer className="px-3 py-1.5 border-t border-neutral-800 text-[10px] text-neutral-500 flex justify-between">
        <span>{descriptors.length} detected</span>
        <span>v0.0.1</span>
      </footer>
    </main>
  );
}
