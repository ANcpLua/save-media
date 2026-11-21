import { useState } from "react";

interface Props {
  readonly body?: string;
  readonly details: string;
  readonly copyText?: string;
}

export function TechnicalDetails({ body, details, copyText = details }: Props) {
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);

  async function copyDetails(): Promise<void> {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <details className="text-muted mt-1">
      <summary className="cursor-pointer">Technical details</summary>
      {body && <p className="mt-1">{body}</p>}
      <p className="mt-1 whitespace-pre-line break-words">{details}</p>
      <button type="button" onClick={copyDetails} className="mt-1.5 text-accent hover:underline">
        Copy details
      </button>
      {copyStatus && <p role="status">{copyStatus === "copied" ? "Copied" : "Select the details to copy them."}</p>}
    </details>
  );
}
