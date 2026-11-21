import { REFRESHING_VIDEO_SOURCE } from "../types/messages";

export interface TransferState {
  stage?: string;
  percent?: number | null;
  bytesWritten?: number;
  bytesTotal?: number | null;
}

const labels: Record<string, string> = {
  probing: "Checking the file",
  downloading: "Downloading",
  verifying: "Verifying the file",
  merging: "Merging tracks",
  finalizing: "Preparing the file for Downloads",
};

export function describeTransfer(status: TransferState) {
  const stage = status.stage ?? "Preparing download";
  const label = labels[stage] ?? stage;
  const transferring = stage === "downloading" || stage.startsWith("Retrying part") || /^segment/i.test(stage);
  const percent = transferring || !(stage in labels) ? progressPercent(status) : undefined;
  const showBytes = transferring && (status.bytesWritten !== undefined || status.bytesTotal != null);
  const retrying = stage.startsWith("Retry") || stage === REFRESHING_VIDEO_SOURCE;
  return {label, percent, showBytes, retrying};
}

function progressPercent(status: TransferState): number | undefined {
  if (status.bytesTotal && status.bytesTotal > 0) {
    return clampPercent(Math.floor(((status.bytesWritten ?? 0) / status.bytesTotal) * 100));
  }

  if (status.percent != null) return clampPercent(status.percent);
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
