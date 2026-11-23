import type { StreamDescriptor, UserChoice } from "@savemedia/core";
import type { HttpReporter } from "../util/http-diagnostics";
import type { RetainedPartial, TransferProgress, TransferStage } from "../types/transfer";

export type { RetainedPartial, TransferProgress, TransferStage };
export type ProgressFn = (progress: TransferProgress) => void;

export interface JobResult {
  readonly blobUrl: string;
  readonly filename: string;
  readonly checksum: string;
}

/**
 * Asks the background to send the page's Referer to the hosts of these
 * addresses, as the page's own player does, before the job requests them.
 * Jobs pass every address they will request; the runner sends each origin
 * once. Settles when the request rules are in place; a failure leaves
 * requests as they were.
 */
export type PrepareRequests = (urls: readonly string[]) => Promise<void>;

/** What a job reports and receives besides its descriptor and choice. */
export interface JobContext {
  readonly onProgress: ProgressFn;
  readonly signal: AbortSignal;
  readonly resumeKey?: string | undefined;
  readonly reportHttp?: HttpReporter | undefined;
  /** Called when a failed direct save keeps its verified bytes for a retry. */
  readonly onRetained?: ((partial: RetainedPartial) => void) | undefined;
  /** Called later, when those kept bytes are released for another save's. */
  readonly onRetainedReleased?: (() => void) | undefined;
  readonly prepareRequests?: PrepareRequests | undefined;
  /**
   * Looks at the address an answer came from, after its redirects. Throws private_network_target when a
   * public page's request ended at a server inside the user's network that the browser itself was not
   * answered from for this tab: the job uses nothing of such an answer.
   */
  readonly checkAnswer?: ((answeredFrom: string) => void) | undefined;
}

export type DownloadJob = (descriptor: StreamDescriptor, choice: UserChoice, context: JobContext) => Promise<JobResult>;

/** One progress report. */
export function report(onProgress: ProgressFn, stage: TransferStage, bytesWritten: number, bytesTotal: number | null): void {
  onProgress({ stage, bytesWritten, bytesTotal });
}
