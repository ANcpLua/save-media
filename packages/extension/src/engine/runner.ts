import { isJobError, type StreamDescriptor, type UserChoice, type JobError } from "@savemedia/core";
import type { EngineEvent, TransferProgressView } from "../types/messages";
import type { Logger } from "../util/logger";
import type { DownloadJob, PrepareRequests, RetainedPartial } from "./job";
import { dispatchRefusalToError } from "../util/dispatch-refusal";
import { observedAmong, unobservedLocalTarget } from "../util/address-space";

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

export interface EngineDeps {
  readonly runtime: { sendMessage: (msg: unknown, cb?: (resp: unknown) => void) => void };
  readonly downloadJob: DownloadJob;
  readonly logger?: Logger;
  /** Prepares the page's request headers for a job's media hosts. */
  readonly prepareRequests?: (streamId: StreamDescriptor["id"], urls: readonly string[]) => Promise<void>;
}

export interface EngineRunner {
  /**
   * `localOrigins`: the origins inside the user's network the browser itself was answered from in the
   * job's tab. For a page on the internet, the job requests no other server there.
   */
  readonly start: (streamId: StreamDescriptor["id"], descriptor: StreamDescriptor, choice: UserChoice, resumeKey?: string,
    localOrigins?: readonly string[]) => Promise<void>;
  readonly cancel: (streamId: StreamDescriptor["id"]) => void;
  readonly active: () => readonly StreamDescriptor["id"][];
  /** The running jobs with the last progress each reported. */
  readonly snapshot: () => readonly { readonly streamId: StreamDescriptor["id"]; readonly progress: TransferProgressView | null }[];
}

/** The most origins one job prepares; the engine-to-background message accepts no more. */
const MAX_PREPARED_ORIGINS = 4096;

/**
 * The page's Referer is set per host, so a job asks once per http(s) origin
 * it will request, however many segments a playlist names. data: and blob:
 * addresses go to no server and are left out.
 */
export function requestOrigins(urls: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const url of urls) {
    try {
      const { protocol, origin } = new URL(url);
      if (protocol === "https:" || protocol === "http:") origins.add(origin);
    } catch { /* not an address */ }
  }
  return [...origins].slice(0, MAX_PREPARED_ORIGINS);
}

export function createEngineRunner(deps: EngineDeps): EngineRunner {
  const jobs = new Map<StreamDescriptor["id"], AbortController>();
  const progress = new Map<StreamDescriptor["id"], TransferProgressView>();

  function send(msg: EngineEvent): void {
    if (msg.type === "progress" && jobs.has(msg.streamId)) {
      progress.set(msg.streamId, { bytesWritten: msg.bytesWritten, bytesTotal: msg.bytesTotal, stage: msg.stage });
    }
    deps.runtime.sendMessage(msg);
  }

  async function start(
    streamId: StreamDescriptor["id"],
    descriptor: StreamDescriptor,
    choice: UserChoice,
    resumeKey?: string,
    localOrigins?: readonly string[],
  ): Promise<void> {
    if (jobs.has(streamId)) {
      return;
    }

    if (descriptor.drm) {
      send({
        type: "failed",
        streamId,
        error: dispatchRefusalToError(descriptor.drm.reason, descriptor),
      });
      return;
    }

    const controller = new AbortController();
    jobs.set(streamId, controller);
    let retained: RetainedPartial | undefined;
    const prepare = deps.prepareRequests;
    // Every address a job is about to request passes here first. A public page's
    // manifest may name a server inside the user's network: the job is sent there
    // only when the browser itself was answered from that server for this tab.
    const observed = observedAmong(localOrigins);
    const refuseInside = (url: string): void => {
      if (unobservedLocalTarget(descriptor.pageUrl, url, observed)) throw { code: "private_network_target", severity: "terminal", host: hostOf(url) } satisfies JobError;
    };
    const prepareRequests: PrepareRequests = async urls => {
      for (const url of urls) refuseInside(url);
      const origins = requestOrigins(urls);
      if (prepare && origins.length) await prepare(streamId, origins);
    };

    try {
      const result = await deps.downloadJob(descriptor, choice, {
        onProgress: progress => send({ type: "progress", streamId, ...progress }),
        signal: controller.signal,
        resumeKey,
        onRetained: partial => { retained = partial; },
        onRetainedReleased: () => send({ type: "retained-released", streamId }),
        prepareRequests,
        // The same rule for where an answer came from: a redirect can lead a request there after it was let through.
        checkAnswer: refuseInside,
      });
      send({
        type: "complete",
        streamId,
        blobUrl: result.blobUrl,
        filename: result.filename,
        checksum: result.checksum,
      });
    } catch (err) {
      send({ type: "failed", streamId, error: toJobError(err, descriptor), ...(retained ? { retained } : {}) });
    } finally {
      jobs.delete(streamId);
      progress.delete(streamId);
    }
  }

  function cancel(streamId: StreamDescriptor["id"]): void {
    const controller = jobs.get(streamId);
    if (!controller) return;
    controller.abort(new DOMException("user-cancelled", "AbortError"));
  }

  return {
    start,
    cancel,
    active: () => Array.from(jobs.keys()),
    snapshot: () => Array.from(jobs.keys(), streamId => ({ streamId, progress: progress.get(streamId) ?? null })),
  };
}

function toJobError(err: unknown, descriptor: StreamDescriptor): JobError {
  if (isJobError(err)) return err;
  if (err instanceof DOMException && err.name === "AbortError") {
    return { code: "user_cancelled", severity: "terminal" };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "engine_job_failed",
    severity: "terminal",
    at: "segment",
    detail: `${descriptor.protocol}/${descriptor.container}: ${message}`,
  };
}
