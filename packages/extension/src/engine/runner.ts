import type { StreamDescriptor, UserChoice, JobError } from "@savemedia/core";
import type { EngineToBackgroundMessage } from "../types/messages";
import type { Logger } from "../util/logger";
import type { DownloadJob } from "./job";
import { dispatchRefusalToError } from "../util/dispatch-refusal";

export interface EngineDeps {
  readonly runtime: { sendMessage: (msg: unknown, cb?: (resp: unknown) => void) => void };
  readonly downloadJob: DownloadJob;
  readonly logger?: Logger;
}

export interface EngineRunner {
  readonly start: (streamId: StreamDescriptor["id"], descriptor: StreamDescriptor, choice: UserChoice) => Promise<void>;
  readonly cancel: (streamId: StreamDescriptor["id"]) => void;
  readonly active: () => readonly StreamDescriptor["id"][];
}

export function createEngineRunner(deps: EngineDeps): EngineRunner {
  const jobs = new Map<StreamDescriptor["id"], AbortController>();

  function send(msg: EngineToBackgroundMessage): void {
    deps.runtime.sendMessage(msg);
  }

  async function start(
    streamId: StreamDescriptor["id"],
    descriptor: StreamDescriptor,
    choice: UserChoice,
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

    try {
      const result = await deps.downloadJob(
        descriptor,
        choice,
        (bytesWritten, bytesTotal, phase) =>
          send({ type: "progress", streamId, bytesWritten, bytesTotal, phase }),
        controller.signal,
      );
      send({
        type: "complete",
        streamId,
        blobUrl: result.blobUrl,
        filename: result.filename,
        checksum: result.checksum,
      });
    } catch (err) {
      send({ type: "failed", streamId, error: toJobError(err, descriptor) });
    } finally {
      jobs.delete(streamId);
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
  };
}

function toJobError(err: unknown, descriptor: StreamDescriptor): JobError {
  if (err && typeof err === "object" && "code" in err && "severity" in err) {
    return err as JobError;
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return { code: "user_cancelled", severity: "terminal", bytesDiscarded: 0 };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "engine_job_failed",
    severity: "terminal",
    at: "segment",
    detail: `${descriptor.protocol}/${descriptor.container}: ${message}`,
  };
}
