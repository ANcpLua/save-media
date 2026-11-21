import type { StreamDescriptor } from "@savemedia/core";
import type { DiscoveredMedia } from "../types/messages";
import { declaredTotalBytes } from "./capture";

interface RefreshDeps {
  readonly tabs: Pick<typeof chrome.tabs, "get" | "create" | "remove" | "onUpdated" | "onRemoved">;
  readonly discover: (tabId: number, pageUrl: string) => Promise<readonly DiscoveredMedia[] | null>;
  readonly list: (tabId: number) => readonly StreamDescriptor[];
}

type DirectDescriptor = StreamDescriptor & { readonly source: Extract<StreamDescriptor["source"], { kind: "direct-url" }> };
const EXPIRING_PARAMETER = /^(token|sig|signature|exp|ex|expires?|expiry|expiration|x-amz-signature|x-amz-date|x-amz-expires|x-goog-signature|x-goog-date|x-goog-expires)$/i;

export function renewableResource(url: string): string | null {
  const parsed = new URL(url);
  parsed.hash = "";
  const renewalKeys = [...parsed.searchParams.keys()].filter(key => EXPIRING_PARAMETER.test(key));
  if (!renewalKeys.length) return null;
  for (const key of renewalKeys) parsed.searchParams.delete(key);
  // Preserve the pathname and every unrelated parameter, including file IDs.
  return parsed.href;
}

function isDirect(descriptor: StreamDescriptor): descriptor is DirectDescriptor {
  return descriptor.source.kind === "direct-url" && descriptor.capabilities.directDownload && !descriptor.drm;
}

/** Recover a previously verified direct file using sources exposed by the same page. */
export async function refreshDirectSource(
  deps: RefreshDeps, original: StreamDescriptor, signal: AbortSignal,
): Promise<StreamDescriptor | null> {
  if (!isDirect(original)) return null;
  const resource = renewableResource(original.source.url);
  // A stable entry can issue a fresh redirect on its own.
  if (!resource) return original.source.finalUrl ? original : null;

  const size = declaredTotalBytes(original.source.headers);
  if (!original.title || !size) return null;
  const page = new URL(original.pageUrl);
  if (!/^https?:$/.test(page.protocol) || page.username || page.password) return null;
  const current = await deps.tabs.get(original.tabId);
  if (current.url !== original.pageUrl || signal.aborted) return null;

  const tab = await deps.tabs.create({ url: original.pageUrl, active: false, windowId: current.windowId });
  if (tab.id === undefined) return null;
  const id = tab.id;
  const closeTab = () => deps.tabs.remove(id).catch(() => undefined);
  const abort = () => { void closeTab(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    // Let the site's ordinary player initialize in a temporary tab. This
    // leaves the user's page, playback, and browsing session in place.
    if (!await waitForPage(deps.tabs, id, original.pageUrl, signal)) return null;
    const sources = await deps.discover(id, original.pageUrl);
    const matches = sources?.filter(source => source.filenameHint === original.title
      && source.url !== original.source.url && renewableResource(source.url) === resource) ?? [];
    if (signal.aborted || matches.length !== 1) return null;
    const source = matches[0]!;
    return deps.list(id).find(candidate => isDirect(candidate) && candidate.source.url === source.url
      && candidate.container === original.container && candidate.title === original.title
      && declaredTotalBytes(candidate.source.headers) === size) ?? null;
  } finally {
    signal.removeEventListener("abort", abort);
    await closeTab();
  }
}

function waitForPage(
  tabs: RefreshDeps["tabs"], id: number, url: string, signal: AbortSignal,
): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = setTimeout(() => finish(false), 8_000);
    function finish(ready: boolean): void {
      clearTimeout(deadline);
      tabs.onUpdated.removeListener(updated);
      tabs.onRemoved.removeListener(removed);
      signal.removeEventListener("abort", cancelled);
      resolve(ready);
    }
    function updated(tabId: number, _change: unknown, tab: chrome.tabs.Tab): void {
      if (tabId === id && tab.status === "complete") finish(tab.url === url);
    }
    function removed(tabId: number): void { if (tabId === id) finish(false); }
    function cancelled(): void { finish(false); }
    tabs.onUpdated.addListener(updated);
    tabs.onRemoved.addListener(removed);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else void tabs.get(id).then(tab => updated(id, {}, tab), cancelled);
  });
}
