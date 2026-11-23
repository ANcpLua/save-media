import { useState } from "react";
import { request } from "../request";
import { ANNOUNCE, POPUP } from "../../ui/text";
import { useAnnounce } from "./Announcer";

export function DiagnosticExport({tabId, pageUrl}: {tabId: number | null; pageUrl: string | null}) {
  const [state, setState] = useState<"ready" | "saving" | "saved" | "failed">("ready");
  const announce = useAnnounce();
  async function save() {
    if (tabId === null || !pageUrl || state === "saving") return;
    setState("saving");
    const reply = await request({type: "export-save-diagnostics", tabId, pageUrl});
    const saved = reply?.ok === true;
    setState(saved ? "saved" : "failed");
    announce(saved ? ANNOUNCE.exported : ANNOUNCE.exportFailed);
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={save} disabled={tabId === null || !pageUrl || state === "saving"}
        className="text-accent hover:underline disabled:text-muted">
        {state === "saving" ? POPUP.exporting : POPUP.exportLog}
      </button>
      {(state === "saved" || state === "failed") && <span data-testid="export-result">{state === "saved" ? POPUP.exported : POPUP.exportFailed}</span>}
    </div>
  );
}
