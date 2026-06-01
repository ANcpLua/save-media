import { useState } from "react";
import type { StreamDescriptor, JobError } from "@savemedia/core";
import { friendlyVideoCodec, friendlyAudioCodec, userMessage } from "@savemedia/core";
import type { PopupToBackgroundMessage } from "../../types/messages";
import { suggestFilename } from "../../util/filename";

export interface JobStatus {
  readonly phase: "queued" | "active" | "complete" | "failed";
  readonly bytesWritten?: number;
  readonly bytesTotal?: number | null;
  readonly stage?: string;
  readonly error?: JobError;
}

interface Props {
  readonly descriptor: StreamDescriptor;
  readonly status?: JobStatus | undefined;
  readonly onCancel?: ((streamId: StreamDescriptor["id"]) => void) | undefined;
}

export function DetectedItem({ descriptor, status, onCancel }: Props) {
  const [expanded, setExpanded] = useState(false);

  const visibleVariants = (descriptor.variants ?? []).filter(v => (v.height ?? 0) >= 720);
  const allBelowMin = descriptor.variants.length > 0 && visibleVariants.length === 0;
  const variant = visibleVariants[0] ?? descriptor.variants[0];
  const vcodec = variant?.videoCodec ?? descriptor.codecs.video;
  const acodec = variant?.audioCodec ?? descriptor.codecs.audio;
  const isDrmBlocked = descriptor.capabilities.drmBlocked;
  const isDeferred = descriptor.drm?.reason === "clearkey_deferred";
  const action = outputActionLabel(descriptor);
  const isDownloadable = descriptor.capabilities.directDownload || descriptor.protocol === "hls";
  const activeProgressWidth = status?.phase === "active" ? progressWidth(status) : "30%";

  function download() {
    if (isDrmBlocked) return;
    const msg: PopupToBackgroundMessage = {
      type: "download",
      streamId: descriptor.id,
      choice: {
        outputMode: "Original",
        filename: suggestFilename(descriptor),
        variantId: variant?.id ?? null,
        audioRenditionId: null,
      },
    };
    chrome.runtime.sendMessage(msg);
  }

  function cancel() {
    if (onCancel) {
      onCancel(descriptor.id);
      return;
    }
    const msg: PopupToBackgroundMessage = { type: "cancel", streamId: descriptor.id };
    chrome.runtime.sendMessage(msg);
  }

  if (isDrmBlocked) {
    return (
      <li
        className="rounded-lg bg-surface border border-red-900/40 p-3 text-xs"
        data-testid="drm-card"
        data-deferred={isDeferred}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-red-400" aria-hidden="true">🔒</span>
          <span className="font-medium truncate">{descriptor.title ?? "Protected stream"}</span>
        </div>
        <p className="text-muted leading-relaxed">
          {isDeferred
            ? "ClearKey / CENC decryption is not implemented."
            : "DRM-protected media. savemedia cannot decrypt this stream."}
        </p>
        <p className="text-neutral-500 mt-1">Reason: <code>{descriptor.drm?.reason}</code></p>
      </li>
    );
  }

  return (
    <li className="rounded-lg bg-surface border border-line p-3 text-xs">
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 w-full text-left mb-1"
      >
        <span className="text-muted">{expanded ? "▼" : "▶"}</span>
        <span className="font-medium truncate flex-1">{descriptor.title ?? descriptor.pageUrl}</span>
      </button>

      <div className="text-muted ml-5 leading-relaxed">
        {variant && <>{variant.width}×{variant.height} · {variant.frameRate ?? "?"} fps · </>}
        {vcodec ? friendlyVideoCodec(vcodec) : "—"}
        {acodec && <> + {friendlyAudioCodec(acodec)}</>}
        {" · "}
        <code>{descriptor.container}</code>
        {allBelowMin && <span className="block text-amber-500 mt-0.5">⚠ source below 720p</span>}
      </div>

      {expanded && (
        <div className="mt-2 ml-5 space-y-1.5 text-muted">
          <Row label="source type" value={descriptor.source.kind} />
          <Row label="protocol" value={descriptor.protocol} />
          <Row label="container" value={descriptor.container} />
          {variant?.bitrate && <Row label="bitrate" value={`${(variant.bitrate / 1e6).toFixed(1)} Mbps`} />}
          {variant?.estimatedSize && <Row label="size (est.)" value={`${(variant.estimatedSize / 1e6).toFixed(1)} MB`} />}
          <Row label="output action" value={action} />
        </div>
      )}

      {status && status.phase === "active" && (
        <div className="mt-2 ml-5" data-testid="progress">
          <div className="flex items-center justify-between text-muted">
            <span>{status.stage ?? "downloading"}</span>
            <span>{formatBytes(status.bytesWritten ?? 0)}{status.bytesTotal ? ` / ${formatBytes(status.bytesTotal)}` : ""}</span>
          </div>
          <div className="mt-1 h-1 rounded bg-surface-2 overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: activeProgressWidth }}
            />
          </div>
        </div>
      )}

      {status?.phase === "failed" && status.error && (
        <div className="mt-2 ml-5 text-red-400" data-testid="job-error">
          <p className="font-medium">{userMessage(status.error).title}</p>
          <p className="text-muted mt-0.5">{userMessage(status.error).body}</p>
        </div>
      )}

      {status?.phase === "complete" && (
        <p className="mt-2 ml-5 text-emerald-400" data-testid="job-complete">✓ Saved.</p>
      )}

      {!isDownloadable && !status && (
        <p className="mt-2 ml-5 text-amber-500" data-testid="unsupported-card">
          {descriptor.protocol === "dash"
            ? "DASH detected. savemedia only downloads verified direct video files and plain HLS VOD playlists."
            : "This media entry is not a supported download."}
        </p>
      )}

      <div className="mt-2 ml-5 flex items-center gap-2">
        {status?.phase === "active" ? (
          <button
            onClick={cancel}
            className="ml-auto bg-surface-2 hover:bg-neutral-600 text-white px-2.5 py-1 rounded-md text-xs"
          >
            Cancel
          </button>
        ) : isDownloadable ? (
          <button
            onClick={download}
            className="ml-auto inline-flex items-center gap-1 bg-accent hover:brightness-110 text-ink font-medium px-2.5 py-1 rounded-md text-xs"
          >
            <span aria-hidden="true">⬇</span> Download
          </button>
        ) : null}
      </div>
    </li>
  );
}

function outputActionLabel(d: StreamDescriptor): string {
  if (d.capabilities.directDownload) return "direct";
  if (d.protocol === "hls") return "hls";
  return "unsupported";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function progressWidth(status: JobStatus): string {
  if (status.bytesTotal && status.bytesTotal > 0) {
    return `${clampPercent(((status.bytesWritten ?? 0) / status.bytesTotal) * 100)}%`;
  }

  const stage = status.stage ?? "";
  const segment = /^segment\s+(\d+)\/(\d+)/i.exec(stage);
  if (segment) {
    const current = Number(segment[1]);
    const total = Number(segment[2]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      return `${clampPercent((current / total) * 100)}%`;
    }
  }

  const percent = /(\d+(?:\.\d+)?)%/.exec(stage);
  if (percent) {
    const value = Number(percent[1]);
    if (Number.isFinite(value)) return `${clampPercent(value)}%`;
  }

  return "30%";
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-neutral-600">{label}</span>
      <code className="truncate max-w-[60%] text-right">{value}</code>
    </div>
  );
}
