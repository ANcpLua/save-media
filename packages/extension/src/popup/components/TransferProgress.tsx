import { describeTransfer, type TransferState } from "../../util/transfer-progress";

export function TransferProgress({status}: {status: TransferState}) {
  const {label, percent, showBytes, retrying} = describeTransfer(status);
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
