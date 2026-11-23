// Why savemedia cannot read a page, decided from structure only: whether the
// page's content script answered, the address scheme, the tab's load state,
// the permissions the user granted, whether this worker saw the tab load, and
// whether the browser reported that the tab's last navigation failed. The
// text of a browser error is never read.

export const PAGE_REACH_KINDS = ["reachable", "load-failed", "needs-reload", "blocked", "site-access-off", "file-access-off", "not-web", "loading"] as const;
export type PageReachKind = typeof PAGE_REACH_KINDS[number];

export interface PageReachInput {
  /** The top frame's content script answered. */
  readonly answered: boolean;
  readonly url: string | undefined;
  /** tab.status */
  readonly status: string | undefined;
  /** This extension saw the tab start loading a document, so its content script was injected then. */
  readonly observedLoad: boolean;
  readonly fileAccess: boolean;
  readonly hostAccess: boolean;
  /** The browser reported that the tab's last top-level navigation failed: the tab shows the browser's error page. */
  readonly loadFailed?: boolean;
}

function protocolOf(url: string | undefined): string {
  try { return new URL(url ?? "").protocol; } catch { return ""; }
}

export function pageReach(input: PageReachInput): PageReachKind {
  if (input.answered) return "reachable";
  // The browser's error page stands where the page would be. A page the browser blocks for extensions loaded without an error.
  if (input.loadFailed) return "load-failed";
  const protocol = protocolOf(input.url);
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "file:") return "not-web";
  if (protocol === "file:" && !input.fileAccess) return "file-access-off";
  if (protocol !== "file:" && !input.hostAccess) return "site-access-off";
  if (input.status === "loading") return "loading";
  return input.observedLoad ? "blocked" : "needs-reload";
}
