import { toastDetail, userMessage, type JobError } from "@savemedia/core";
import type { HotkeyFeedbackOutcome } from "../types/messages";
import { HOTKEY, localFailureMessage } from "../ui/text";
import type { BackgroundEvent } from "./events";

/**
 * A save Alt+S started owes its tab a toast when it ends: "Saved", "Not
 * saved" or "Cancelled". The popup is normally closed on that path, so
 * nothing else would tell the user. The job's record says who started it, so
 * the toast is also sent when the worker restarted during the save. A save
 * the popup started gets no toast, in the browser or with the Local
 * downloader: the popup shows it.
 */
export function createHotkeyObserver(
  notify: (tabId: number, outcome: HotkeyFeedbackOutcome, detail: string) => void,
): (event: BackgroundEvent) => void {
  return event => {
    if (event.type === "local-job") {
      const { job } = event;
      if (event.origin !== "hotkey" || job.tabId === null) return;
      if (job.phase === "complete") notify(job.tabId, "complete", job.filename ?? HOTKEY.savedFallback);
      else if (job.phase === "failed" && job.failure?.code === "cancelled") notify(job.tabId, "cancelled", HOTKEY.nothingSaved);
      else if (job.phase === "failed" && job.failure) notify(job.tabId, "failed", toastDetail(localFailureMessage(job.failure)));
      return;
    }
    if (event.type !== "job" || event.origin !== "hotkey" || event.previous?.phase !== "active") return;
    const { status } = event;
    if (status.phase === "complete") notify(event.tabId, "complete", basename(status.savedAs) || HOTKEY.savedFallback);
    // The user's own cancel is a neutral end, never a failure.
    else if (status.phase === "cancelled") notify(event.tabId, "cancelled", status.fileName ?? HOTKEY.nothingSaved);
    else if (status.phase === "failed" && status.error) notify(event.tabId, "failed", failureToast(status.error));
  };
}

function basename(path: string | null | undefined): string {
  if (!path) return "";
  return path.split(/[\\/]/).pop() ?? path;
}

/** The toast's detail for a failure: what happened and, when there is one, what to do. The same text the popup leads with. */
export function failureToast(error: JobError): string {
  return toastDetail(userMessage(error));
}
