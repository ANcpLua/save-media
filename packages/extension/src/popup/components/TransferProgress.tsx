import { useEffect, useState } from "react";
import { formatBytes } from "@savemedia/core";
import { describeTransfer, retainedMinutes, type TransferState } from "../../util/transfer-progress";
import type { RetainedPartial } from "../../types/transfer";
import { POPUP, retainedText } from "../../ui/text";

/** Bytes a failed save kept for Retry save, with the time left to use them. */
export function RetainedBytes({ retained }: { readonly retained: RetainedPartial | undefined }) {
  const minutes = retained && retained.bytes > 0 ? retainedMinutes(retained.expiresAt) : null;
  if (!retained || minutes === null) return null;
  return <p className="mt-1 text-muted tabular-nums" data-testid="retained-bytes">
    {retainedText(formatBytes(retained.bytes), formatBytes(retained.total), minutes)}
  </p>;
}

/**
 * A transfer's stage and bar. The label is plain text, not a live region:
 * it changes with every stage, and the popup announces the stages worth
 * hearing once each.
 */
export function TransferProgress({ status }: { readonly status: TransferState }) {
  // A wait counts down: the label is drawn again each second while it runs, and only then.
  const [, tick] = useState(0);
  const view = describeTransfer(status);
  useEffect(() => {
    if (!view.waiting) return undefined;
    const timer = setInterval(() => tick(count => count + 1), 1_000);
    return () => clearInterval(timer);
  }, [view.waiting]);
  const { label, percent, bytesText, retrying } = view;
  const valueText = [percent === undefined ? null : `${percent}%`, bytesText].filter(Boolean).join(", ");
  return <div className="mt-2" data-testid="progress">
    <div className="flex items-baseline justify-between gap-2">
      <span className={retrying ? "text-orange-300" : "text-white"} data-testid="progress-label">{label}</span>
      {bytesText && <span className="text-muted tabular-nums" data-testid="progress-bytes">{bytesText}</span>}
    </div>
    <progress aria-label={POPUP.progressName} aria-valuetext={valueText || label} value={percent} max={100}
      className={`mt-1.5 block h-1.5 w-full ${retrying ? "accent-orange-400" : "accent-sky-400"}`}/>
  </div>;
}
