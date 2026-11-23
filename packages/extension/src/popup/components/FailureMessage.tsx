import type { ReactNode } from "react";
import type { MessageTone, UserMessage } from "@savemedia/core";
import type { RetainedPartial } from "../../types/transfer";
import { RetainedBytes } from "./TransferProgress";
import { TechnicalDetails } from "./TechnicalDetails";

/** Red is for a file that is not what it should be. A server that could not be reached is orange. Protection is stated, not coloured as an error. */
const TONE_CLASS: Readonly<Record<MessageTone, string>> = {
  protected: "text-white",
  unusable: "text-red-300",
  unavailable: "text-orange-300",
  neutral: "text-muted",
};

/**
 * Whether the button under a failure reads "Retry save". Only where pressing it can help as things are: the
 * message offers it, or kept bytes wait for it. Otherwise the user follows the hint first, and the button is
 * the plain Save. A failure that came with no message says nothing against trying again.
 */
export function offersRetry(message: Pick<UserMessage, "action"> | null, retained: RetainedPartial | undefined): boolean {
  return message === null || message.action !== null || retained !== undefined;
}

interface Props {
  readonly message: UserMessage;
  /** Bytes a failed save kept for Retry save. */
  readonly retained?: RetainedPartial | undefined;
  /** What else can be tried, such as the Local downloader. */
  readonly extra?: ReactNode;
  readonly testId?: "job-error" | "file-save-problem" | "discovery-failure" | "local-job-failed" | "drm-card" | "unsupported-card" | "live-card" | "could-not-start";
  readonly className?: string;
}

/**
 * The one way a failure or a refusal is shown: what happened, in plain
 * words that are always visible, what the user can do, and the technical
 * facts behind a disclosure. It has no live region of its own: a failure
 * that happens while the popup is open is announced by the popup.
 */
export function FailureMessage({ message, retained, extra, testId, className }: Props) {
  return (
    <div className={className} data-testid={testId} data-tone={message.tone}>
      <p className={`font-medium ${TONE_CLASS[message.tone]}`} data-testid="failure-title">{message.title}</p>
      <p className="text-muted mt-0.5" data-testid="failure-body">{message.body}</p>
      {message.hint && <p className="mt-0.5 text-white" data-testid="failure-hint">{message.hint}</p>}
      {extra}
      <RetainedBytes retained={retained}/>
      <TechnicalDetails rows={message.details}/>
    </div>
  );
}
