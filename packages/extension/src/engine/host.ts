import type { JobError } from "@savemedia/core";
import type {
  BackgroundToEngineMessage,
  EngineToBackgroundMessage,
} from "../types/messages";

function send(msg: EngineToBackgroundMessage): void {
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
}

async function startJob(msg: Extract<BackgroundToEngineMessage, { type: "start-job" }>): Promise<void> {
  const { streamId, descriptor, choice } = msg;

  if (descriptor.drm) {
    fail(streamId, drmError(descriptor.drm));
    return;
  }

  if (descriptor.protocol === "progressive-http" && descriptor.source.kind === "direct-url") {
    finalizeDirect(streamId, descriptor.source.url, choice.filename);
    return;
  }

  if (descriptor.protocol === "hls") {
    fail(streamId, {
      code: "no_remux_path",
      severity: "terminal",
      from: descriptor.container,
      to: "mp4",
      reason: "container-not-supported-by-mediabunny",
    });
    return;
  }

  if (descriptor.protocol === "dash") {
    fail(streamId, {
      code: "no_remux_path",
      severity: "terminal",
      from: descriptor.container,
      to: "mp4",
      reason: "container-not-supported-by-mediabunny",
    });
    return;
  }

  fail(streamId, {
    code: "no_remux_path",
    severity: "terminal",
    from: descriptor.container,
    to: "mp4",
    reason: "container-not-supported-by-mediabunny",
  });
}

function finalizeDirect(streamId: ReturnType<typeof String>, url: string, filename: string): void {
  send({
    type: "complete",
    streamId: streamId as Parameters<typeof send>[0] extends { streamId: infer S } ? S : never,
    blobUrl: url,
    filename,
    checksum: "",
  });
}

function fail(streamId: unknown, error: JobError): void {
  send({ type: "failed", streamId: streamId as never, error });
}

function drmError(drm: NonNullable<import("@savemedia/core").StreamDescriptor["drm"]>): JobError {
  switch (drm.reason) {
    case "encrypted_media_detected":
      return { code: "encrypted_media_detected", severity: "terminal", detectedVia: drm.detectedVia, keySystem: drm.keySystem };
    case "cdm_required":
      return { code: "cdm_required", severity: "terminal", keySystem: drm.keySystem ?? "unknown" };
    case "clear_segments_unavailable":
      return { code: "clear_segments_unavailable", severity: "terminal", manifestUrl: "" };
    case "license_bound_stream":
      return { code: "license_bound_stream", severity: "terminal", keyUri: "", httpStatus: 0 };
    case "clearkey_deferred":
      return { code: "clearkey_deferred", severity: "terminal", manifestUrl: "" };
  }
}

chrome.runtime.onMessage.addListener((msg: BackgroundToEngineMessage, _sender, sendResponse) => {
  if (msg.type === "start-job") {
    void startJob(msg);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "cancel-job") {
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
