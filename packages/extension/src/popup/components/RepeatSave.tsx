import { useEffect, useState } from "react";
import type { RepeatPromptView } from "../../types/messages";
import { ask, fromBackground, request } from "../request";
import { REPEAT } from "../../ui/text";
import { useAnnounce } from "./Announcer";

type Prompt = RepeatPromptView;

export function useRepeatPrompt(tabId: number | null, pageUrl: string | null) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  useEffect(() => {
    setPrompt(null);
    if (tabId === null || !pageUrl) return;
    let revision = 0;
    function refresh() {
      const asked = ++revision;
      ask({type: "current-save-state", tabId: tabId!, pageUrl: pageUrl!}, state => {
        if (asked === revision) setPrompt(state?.prompt ?? null);
      });
    }
    function changed(msg: {type?: string; tabId?: number; pageUrl?: string}, sender: chrome.runtime.MessageSender,
      respond: (shown: boolean) => void) {
      if (fromBackground(sender) && msg?.type === "repeat-save-changed" && msg.tabId === tabId && msg.pageUrl === pageUrl) {
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

/** The one question before a file is saved a second time. Focus starts on the answer that goes on. */
export function RepeatSave({prompt}: {prompt: Prompt}) {
  const announce = useAnnounce();
  useEffect(() => { announce(REPEAT.question); }, [announce, prompt.id]);
  const answer = (allow: boolean) => void request({type: "answer-repeat-save", id: prompt.id, allow});
  return <div className="mx-2 mb-2 rounded-lg border border-line bg-surface p-3 text-xs" data-testid="repeat-save">
    <p className="break-words font-semibold">{prompt.filename}</p>
    <p className="mt-2">{REPEAT.question}</p>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" className="rounded border border-line px-2 py-1" onClick={() => answer(false)}>{REPEAT.cancel}</button>
      <button type="button" autoFocus className="rounded bg-surface-2 px-2 py-1 font-medium" onClick={() => answer(true)}>{REPEAT.confirm}</button>
    </div>
  </div>;
}
