import { REFRESHING_VIDEO_SOURCE } from "../../types/messages";

interface Progress {
  stage?: string;
  bytesWritten?: number;
  bytesTotal?: number | null;
}

const labels: Record<string, string> = {
  probing: "Checking the file",
  downloading: "Downloading",
  verifying: "Verifying the file",
  finalizing: "Preparing the file for Downloads",
};

export function TransferProgress({status}: {status: Progress}) {
  const stage = status.stage ?? "Preparing download";
  const label = labels[stage] ?? stage;
  const transferring = stage === "downloading" || stage.startsWith("Retrying part") || /^segment/i.test(stage);
  const percent = transferring || !(stage in labels) ? progressPercent(status) : undefined;
  const showBytes = transferring && (status.bytesWritten !== undefined || status.bytesTotal != null);
  const retrying = stage.startsWith("Retry") || stage === REFRESHING_VIDEO_SOURCE;
  return <div className="mt-2" data-testid="progress">
    <div className="flex items-baseline justify-between gap-2">
      <span role="status" className={retrying ? "text-orange-300" : "text-white"}>{label}</span>
      {showBytes && <span className="text-muted tabular-nums">{formatBytes(status.bytesWritten ?? 0)}
        {status.bytesTotal ? ` / ${formatBytes(status.bytesTotal)}` : " received"}</span>}
    </div>
    <progress aria-label={label} value={percent} max={100}
      className={`mt-1.5 block h-1.5 w-full ${retrying ? "accent-orange-400" : "accent-sky-400"}`}/>
  </div>;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function progressPercent(status: Progress): number | undefined {
  if (status.bytesTotal && status.bytesTotal > 0) {
    return clampPercent(((status.bytesWritten ?? 0) / status.bytesTotal) * 100);
  }

  const stage = status.stage ?? "";
  const segment = /^segment\s+(\d+)\/(\d+)/i.exec(stage);
  if (segment) {
    const current = Number(segment[1]);
    const total = Number(segment[2]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      return clampPercent((current / total) * 100);
    }
  }

  const percent = /(\d+(?:\.\d+)?)%/.exec(stage);
  if (percent) {
    const value = Number(percent[1]);
    if (Number.isFinite(value)) return clampPercent(value);
  }

  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
