import type { BestDownloadOutcome } from "./router";
import {
  MAIN_BRIDGE_TAG,
  type BackgroundToContentMessage,
  type BackgroundToPopupMessage,
  type BridgeToBackgroundMessage,
  type ContentDiscoveryResponse,
  type DiscoveredMedia,
  type FileDownloadOffer,
  type FileSaveProblem,
  type HotkeyFeedbackOutcome,
  type LocalJobView,
} from "../types/messages";
import { hotkeyErrorDetail } from "./hotkey-jobs";
import { describeFileSaveProblem } from "./file-save-problem";
import { renewableResource } from "./refresh-direct";
import { isDelegableError } from "../native/local-downloader";

type CaptureMessage = Extract<BridgeToBackgroundMessage, { type: "capture" }>;

interface ActiveTab {
  readonly id?: number | undefined;
  readonly url?: string | undefined;
}

export interface DownloadBestDeps {
  readonly tabs: {
    readonly query: (queryInfo: { readonly active: true; readonly currentWindow: true }) => Promise<readonly ActiveTab[]>;
    readonly sendMessage: (
      tabId: number,
      msg: BackgroundToContentMessage,
      cb: (response: ContentDiscoveryResponse | undefined) => void,
    ) => void;
    readonly isOnPage?: (tabId: number, pageUrl: string) => Promise<boolean>;
  };
  readonly runtime: {
    readonly lastError: () => unknown;
    readonly sendMessage: (msg: BackgroundToPopupMessage, cb?: () => void) => void;
  };
  readonly router: {
    readonly startBestDownload: (tabId: number) => Promise<BestDownloadOutcome>;
    readonly setDiscoveryScope: (tabId: number, pageUrl: string, urls: readonly string[]) => void;
  };
  readonly handleCapture: (tabId: number, msg: CaptureMessage, observedUrl?: string, referrerPage?: string) => Promise<void>;
  readonly generateDownload?: (tabId: number, pageUrl: string, offer: FileDownloadOffer) => Promise<DiscoveredMedia | null>;
  readonly rememberFileSaveProblem?: (tabId: number, pageUrl: string, problem: FileSaveProblem | null) => Promise<void>;
  /**
   * Visible per-tab feedback for the hotkey path. The popup is usually
   * closed when Alt+S fires, so job-failed messages alone leave the user
   * staring at a page where "nothing happened".
   */
  readonly showHotkeyFeedback: (tabId: number, outcome: HotkeyFeedbackOutcome, detail: string) => void;
  /**
   * Optional local downloader (user-installed yt-dlp host). Consulted only
   * when the in-browser engine has nothing to save or refused for a
   * non-DRM reason; see DELEGABLE_ERROR_CODES.
   */
  readonly localFallback?: (pageUrl: string, tabId: number) => Promise<LocalJobView | null>;
  /**
   * Remembers a job Alt+S started, so its end can still reach the page as a
   * Saved or Not saved toast after "Saving" (see hotkey-jobs.ts).
   */
  readonly trackHotkeyJob?: (streamId: BestDownloadStreamId, tabId: number) => void;
}

type BestDownloadStreamId = Extract<BestDownloadOutcome, { kind: "started" }>["streamId"];

export interface CommandsLike {
  readonly onCommand: {
    readonly addListener: (listener: (command: string) => void) => void;
  };
}

export async function discoverPageMediaForTab(
  deps: Pick<DownloadBestDeps, "tabs" | "runtime" | "handleCapture" | "router" | "generateDownload">,
  tabId: number,
  fallbackPageUrl: string,
  expectedPageUrl?: string,
  generate = false,
): Promise<{ pageUrl: string; media: readonly DiscoveredMedia[]; fileDownload?: FileDownloadOffer } | null> {
  const request: BackgroundToContentMessage = { type: "discover-page-media" };
  const response = await new Promise<ContentDiscoveryResponse | null>(resolve => {
    deps.tabs.sendMessage(tabId, request, resp => {
      if (deps.runtime.lastError()) {
        resolve(null);
        return;
      }
      resolve(resp ?? null);
    });
  });

  if (!response) return null;
  const pageUrl = response.pageUrl || fallbackPageUrl;
  if (expectedPageUrl !== undefined && response.pageUrl !== expectedPageUrl) return null;
  const discovered = response.media ?? response.urls.map(url => ({ url }));
  const offer = response.fileDownload;
  const generated = generate && offer ? await deps.generateDownload?.(tabId, pageUrl, offer) : null;
  const media = generated ? [...discovered, generated] : discovered;
  // New bridges return only the main player's sources. Scope both the popup
  // and the hotkey to them, including when previews were captured earlier.
  if (response.media) deps.router.setDiscoveryScope(tabId, pageUrl, media.map(item => item.url));
  for (const item of discovered) await probeSource(deps, tabId, pageUrl, item);
  if (generated) await probeSource(deps, tabId, pageUrl, generated, offer?.linkedPage);
  return { pageUrl, media, ...(offer ? { fileDownload: offer } : {}) };
}

function probeSource(
  deps: Pick<DownloadBestDeps, "handleCapture">, tabId: number, pageUrl: string,
  source: DiscoveredMedia, referrerPage?: string,
): Promise<void> {
  const message: CaptureMessage = { type: "capture", payload: {
    [MAIN_BRIDGE_TAG]: true,
    kind: "media-source",
    url: source.url,
    pageUrl,
    ...(source.quality ? { quality: source.quality } : {}),
    ...(source.filenameHint ? { filenameHint: source.filenameHint } : {}),
  } };
  return referrerPage ? deps.handleCapture(tabId, message, undefined, referrerPage) : deps.handleCapture(tabId, message);
}

export async function downloadBestForActiveTab(deps: DownloadBestDeps): Promise<void> {
  const [tab] = await deps.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (!tabId) return;

  await downloadBestForTab(deps, tabId, tab.url ?? "").catch(() => {
    deps.showHotkeyFeedback(tabId, "failed", "Couldn’t start the download. Try again.");
  });
}

export async function downloadBestForTab(
  deps: DownloadBestDeps,
  tabId: number,
  fallbackPageUrl: string,
  fromPopup = false,
): Promise<void> {
  const discovery = await discoverPageMediaForTab(deps, tabId, fallbackPageUrl, fromPopup ? fallbackPageUrl : undefined);
  if (fromPopup && !discovery) return;
  let outcome = await deps.router.startBestDownload(tabId);
  const offer = discovery?.fileDownload;
  if (offer && (outcome.kind === "no-media" || (outcome.kind === "failed" && outcome.duringDiscovery))) {
    if (!fromPopup) deps.showHotkeyFeedback(tabId, "preparing", "Checking the file link");
    await deps.rememberFileSaveProblem?.(tabId, discovery.pageUrl, null);
    const result = await startFilePageDownload(deps, tabId, discovery.pageUrl, offer);
    if (!result) return;
    if ("problem" in result) {
      if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, discovery.pageUrl)) return;
      await deps.rememberFileSaveProblem?.(tabId, discovery.pageUrl, result.problem);
      deps.showHotkeyFeedback(tabId, "failed", `${result.problem.title}. Open SaveMedia for details.`);
      return;
    }
    outcome = result;
  } else if (offer && outcome.kind === "started") {
    await deps.rememberFileSaveProblem?.(tabId, discovery.pageUrl, null);
  }
  if (fromPopup) return;

  if (outcome.kind === "started") {
    deps.trackHotkeyJob?.(outcome.streamId, tabId);
    deps.showHotkeyFeedback(tabId, "started", "Saving best quality");
    return;
  }

  const delegable = !offer && (outcome.kind === "no-media" || isDelegableError(outcome.error));
  if (delegable && deps.localFallback && fallbackPageUrl) {
    const job = await deps.localFallback(fallbackPageUrl, tabId);
    if (job) {
      deps.showHotkeyFeedback(tabId, "delegated", "Handed to local downloader");
      return;
    }
  }

  if (outcome.kind === "no-media") {
    deps.showHotkeyFeedback(tabId, "no-media", "No supported media on this page");
    return;
  }

  deps.showHotkeyFeedback(tabId, "failed", hotkeyErrorDetail(outcome.error));
  const msg: BackgroundToPopupMessage = {
    type: "job-failed",
    streamId: outcome.streamId,
    error: outcome.error,
  };
  deps.runtime.sendMessage(msg, () => undefined);
}

async function startFilePageDownload(
  deps: DownloadBestDeps, tabId: number, pageUrl: string, offer: FileDownloadOffer,
): Promise<Extract<BestDownloadOutcome, { kind: "started" }> | { problem: FileSaveProblem } | null> {
  let source = await deps.generateDownload?.(tabId, pageUrl, offer);
  if (!source) return { problem: describeFileSaveProblem(offer.filename, "download link") };

  for (let attempt = 0; ; attempt++) {
    await probeSource(deps, tabId, pageUrl, source, offer.linkedPage);
    if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, pageUrl)) return null;
    // A passive scan may have changed scope while the probe was in flight.
    // Select the address actually issued by the site's download control.
    deps.router.setDiscoveryScope(tabId, pageUrl, [source.url]);
    const outcome = await deps.router.startBestDownload(tabId);
    if (outcome.kind === "started") return outcome;

    const error = outcome.kind === "failed" ? outcome.error : undefined;
    const stage = outcome.kind === "failed" && !outcome.duringDiscovery ? "start download" : "file connection";
    const problem = describeFileSaveProblem(offer.filename, stage, error);
    if (attempt > 0) return { problem };
    const expiredResource = error?.code === "access_denied" && error.httpStatus === 403
      ? renewableResource(source.url) : null;
    const certificateFailure = stage === "file connection" && error?.code === "tls_certificate_rejected";
    if (!expiredResource && !certificateFailure) return { problem };

    // Only the original file's Download control can supply a replacement.
    const refreshed = await deps.generateDownload?.(tabId, pageUrl, offer);
    if (!refreshed || refreshed.url === source.url) return { problem };
    if (certificateFailure) {
      const previous = new URL(renewableResource(source.url) ?? source.url);
      const next = new URL(renewableResource(refreshed.url) ?? refreshed.url);
      if (next.protocol !== "https:" || next.host === error.browserDiagnostic.host
        || next.pathname !== previous.pathname || next.search !== previous.search) return { problem };
    } else if (renewableResource(refreshed.url) !== expiredResource) {
      return { problem };
    }
    source = refreshed;
  }
}

export function registerDownloadBestCommand(commands: CommandsLike | undefined, deps: DownloadBestDeps): void {
  commands?.onCommand.addListener(command => {
    if (command === "download-best") void downloadBestForActiveTab(deps);
  });
}
