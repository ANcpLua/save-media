import type { StreamDescriptor, UserChoice, JobError, DrmReason } from "@savemedia/core";
import type { EngineToBackgroundMessage } from "../types/messages";
import type { Logger } from "../util/logger";
import type { DownloadJob } from "./job";

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
      send({ type: "failed", streamId, error: drmError(descriptor.drm.reason, descriptor) });
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

function drmError(reason: DrmReason, d: StreamDescriptor): JobError {
  const drm = d.drm;
  switch (reason) {
    case "encrypted_media_detected":
      return { code: "encrypted_media_detected", severity: "terminal", detectedVia: drm?.detectedVia ?? [], keySystem: drm?.keySystem ?? null };
    case "cdm_required":
      return { code: "cdm_required", severity: "terminal", keySystem: drm?.keySystem ?? "unknown" };
    case "clear_segments_unavailable":
      return { code: "clear_segments_unavailable", severity: "terminal", manifestUrl: d.pageUrl };
    case "license_bound_stream":
      return { code: "license_bound_stream", severity: "terminal", keyUri: "", httpStatus: 0 };
    case "clearkey_deferred":
      return { code: "clearkey_deferred", severity: "terminal", manifestUrl: d.pageUrl };
  }
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
