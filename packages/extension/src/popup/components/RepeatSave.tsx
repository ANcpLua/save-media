import { useEffect, useState } from "react";

interface Prompt {id: string; filename: string; tabId: number; pageUrl: string}

export function useRepeatPrompt(tabId: number | null, pageUrl: string | null) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  useEffect(() => {
    setPrompt(null);
    if (tabId === null || !pageUrl) return;
    let revision = 0;
    function refresh() {
      const request = ++revision;
      chrome.runtime.sendMessage({type: "current-save-state", tabId, pageUrl}, state => {
        void chrome.runtime.lastError;
        if (request === revision) setPrompt(state?.prompt ?? null);
      });
    }
    function changed(msg: {type?: string; tabId?: number; pageUrl?: string}, _sender: chrome.runtime.MessageSender,
      respond: (shown: boolean) => void) {
      if (msg?.type === "repeat-save-changed" && msg.tabId === tabId && msg.pageUrl === pageUrl) {
        refresh();
        respond(true);
      }
      return false;
    }
    chrome.runtime.onMessage.addListener(changed);
    refresh();
    return () => { revision++; chrome.runtime.onMessage.removeListener(changed); };
  }, [tabId, pageUrl]);
  return prompt?.tabId === tabId && prompt?.pageUrl === pageUrl ? prompt : null;
}

export function RepeatSave({prompt}: {prompt: Prompt}) {
  const answer = (allow: boolean) => chrome.runtime.sendMessage({type: "answer-repeat-save", id: prompt.id, allow},
    () => void chrome.runtime.lastError);
  return <div className="mx-2 mb-2 rounded-lg border border-line bg-surface p-3 text-xs">
    <p className="break-words font-semibold">{prompt.filename}</p>
    <p className="mt-2" role="status">SaveMedia already saved this file in this browser session. Save another copy?</p>
    <div className="mt-3 flex justify-end gap-2">
      <button className="rounded border border-line px-2 py-1" onClick={() => answer(false)}>Cancel</button>
      <button className="rounded bg-surface-2 px-2 py-1 font-medium" onClick={() => answer(true)}>Save another copy</button>
    </div>
  </div>;
}
