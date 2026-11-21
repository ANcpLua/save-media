import { userMessage, type JobError, type StreamId } from "@savemedia/core";
import type { BackgroundToPopupMessage, HotkeyFeedbackOutcome } from "../types/messages";

export interface HotkeyFeedback {
  readonly tabId: number;
  readonly outcome: HotkeyFeedbackOutcome;
  readonly detail: string;
}

/**
 * Engine jobs started by Alt+S, remembered until the engine reports how they
 * ended. On that path the popup is normally closed, so job-complete and
 * job-failed reach nobody, and the page kept showing "Saving" forever: after
 * a successful save and, worse, after a refusal the engine only discovers at
 * run time (a FairPlay key tag on the media playlist, say).
 */
export interface HotkeyJobs {
  readonly track: (streamId: StreamId, tabId: number) => void;
  /** The toast a finished job owes its tab, or null when Alt+S did not start it. */
  readonly feedbackFor: (message: BackgroundToPopupMessage) => HotkeyFeedback | null;
}

export function createHotkeyJobs(): HotkeyJobs {
  const tabsByStream = new Map<StreamId, number>();
  return {
    track(streamId, tabId) {
      tabsByStream.set(streamId, tabId);
    },
    feedbackFor(message) {
      if (message.type !== "job-complete" && message.type !== "job-failed") return null;
      const tabId = tabsByStream.get(message.streamId);
      if (tabId === undefined) return null;
      tabsByStream.delete(message.streamId);
      if (message.type === "job-complete") {
        return { tabId, outcome: "complete", detail: basename(message.path) || "Download finished" };
      }
      return { tabId, outcome: "failed", detail: hotkeyErrorDetail(message.error) };
    },
  };
}

function basename(path: string | null | undefined): string {
  if (!path) return "";
  return path.split(/[\\/]/).pop() ?? path;
}

export function hotkeyErrorDetail(error: JobError): string {
  const { title, action } = userMessage(error);
  if (error.code === "unexpected_media_response" || error.code === "access_denied") {
    return `${title}. Reload the file page and try again.`;
  }
  return action?.kind === "retry-job" ? `${title}. Try Alt+S again in a moment.` : title;
}
