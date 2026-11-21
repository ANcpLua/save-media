import type { BestDownloadOutcome, NamedFile } from "./router";
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
import type { CaptureResult } from "./capture";
import { hotkeyErrorDetail } from "./hotkey-jobs";
import { describeFileSaveProblem } from "./file-save-problem";
import { renewableResource, stableAddress } from "../util/media-address";
import { isDelegableError } from "../native/local-downloader";
import { canRecoverFile } from "../native/file-connection";

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
    readonly snapshot?: (tabId: number) => Extract<BackgroundToPopupMessage, { type: "descriptors" }>;
    readonly startBestDownload: (tabId: number, file?: NamedFile) => Promise<BestDownloadOutcome>;
    readonly setDiscoveryScope: (tabId: number, pageUrl: string, urls: readonly string[]) => void;
  };
  readonly handleCapture: (tabId: number, msg: CaptureMessage, observedUrl?: string, referrerPage?: string) => Promise<CaptureResult>;
  readonly handleSaveCapture?: DownloadBestDeps["handleCapture"];
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
  preferFileControl = false,
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
  if (preferFileControl && offer) return { pageUrl, media: discovered, fileDownload: offer };
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
): Promise<CaptureResult> {
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
  const saveDeps = deps.handleSaveCapture ? { ...deps, handleCapture: deps.handleSaveCapture } : deps;
  const discovery = await discoverPageMediaForTab(saveDeps, tabId, fallbackPageUrl, fromPopup ? fallbackPageUrl : undefined, false, true);
  if (fromPopup && !discovery && deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, fallbackPageUrl)) return;
  const offer = discovery?.fileDownload;
  let outcome: BestDownloadOutcome;
  if (offer) {
    await deps.rememberFileSaveProblem?.(tabId, discovery.pageUrl, null);
    if (!fromPopup) deps.showHotkeyFeedback(tabId, "preparing", "Checking the site’s download link");
    const result = await startFilePageDownload(saveDeps, tabId, discovery.pageUrl, offer, fromPopup);
    if (!result) return;
    if ("problem" in result) {
      if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, discovery.pageUrl)) return;
      await deps.rememberFileSaveProblem?.(tabId, discovery.pageUrl, result.problem);
      deps.showHotkeyFeedback(tabId, "failed", result.problem.title);
      return;
    }
    outcome = result;
  } else {
    if (!discovery?.media.length && deps.handleSaveCapture) {
      const state = deps.router.snapshot?.(tabId);
      const failures = state?.failures?.filter(f => canRecoverFile(f.error));
      if (state && !state.descriptors.length && failures?.length === 1
        && (!deps.tabs.isOnPage || await deps.tabs.isOnPage(tabId, fallbackPageUrl))) {
        await probeSource(saveDeps, tabId, fallbackPageUrl, { url: failures[0]!.url });
      }
    }
    outcome = await deps.router.startBestDownload(tabId);
  }
  if (outcome.kind === "skipped") return;
  if (fromPopup) {
    if (outcome.kind === "failed") deps.runtime.sendMessage({ type: "job-failed", streamId: outcome.streamId, error: outcome.error });
    return;
  }

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

type FilePageResult = Extract<BestDownloadOutcome, { kind: "started" }> | { problem: FileSaveProblem } | null;
const pendingFileLinks = new Map<string, Promise<FilePageResult>>();

function reportFileRetry(deps: DownloadBestDeps, tabId: number, pageUrl: string, fromPopup: boolean): void {
  if (fromPopup) deps.runtime.sendMessage({ type: "retrying-file-link", tabId, pageUrl });
  else deps.showHotkeyFeedback(tabId, "retrying", "Trying the site’s download link");
}

function startFilePageDownload(
  deps: DownloadBestDeps, tabId: number, pageUrl: string, offer: FileDownloadOffer, fromPopup: boolean,
): Promise<FilePageResult> {
  // A popup click and a shortcut can overlap before either has a stream ID.
  const key = JSON.stringify([tabId, pageUrl, offer.filename, offer.linkedPage]);
  const pending = pendingFileLinks.get(key);
  if (pending) return pending;
  const starting = resolveAndStartFileDownload(deps, tabId, pageUrl, offer, fromPopup).finally(() => pendingFileLinks.delete(key));
  pendingFileLinks.set(key, starting);
  return starting;
}

async function resolveAndStartFileDownload(
  deps: DownloadBestDeps, tabId: number, pageUrl: string, offer: FileDownloadOffer, fromPopup: boolean,
): Promise<FilePageResult> {
  let control = offer;
  let source = offer.linkedPage ? { url: offer.linkedPage, filenameHint: offer.filename }
    : await deps.generateDownload?.(tabId, pageUrl, offer);
  const tried = new Set<string>();
  const failedRoutes = new Set<string>();
  let followedDocument = false;
  for (let renewals = 0; source; ) {
    tried.add(source.url);
    const probe = await probeSource(deps, tabId, pageUrl, source, followedDocument ? control.linkedPage : undefined);
    if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, pageUrl)) return null;
    if (probe?.documentUrl && offer.linkedPage && !followedDocument) {
      // A Download anchor may redirect straight to media or land on a page
      // whose own control issues the file. Use the address Chrome reached.
      followedDocument = true;
      control = { filename: offer.filename, linkedPage: probe.documentUrl };
      source = await deps.generateDownload?.(tabId, pageUrl, control);
      continue;
    }
    deps.router.setDiscoveryScope(tabId, pageUrl, [source.url]);
    const outcome = await deps.router.startBestDownload(tabId, { pageUrl, ...offer });
    if (outcome.kind === "skipped") return null;
    if (outcome.kind === "started") return outcome;

    const error = outcome.kind === "failed" ? outcome.error : undefined;
    const stage = outcome.kind === "failed" && !outcome.duringDiscovery ? "start download" : "file connection";
    const problem = describeFileSaveProblem(offer.filename, stage, error);
    const certificate = error?.code === "tls_certificate_rejected" ? error.browserDiagnostic : null;
    const renewable = error?.code === "access_denied" && error.httpStatus === 403 && renewableResource(source.url);
    if (stage !== "file connection" || (!certificate && !renewable) || renewals >= 3) return { problem };

    const entry = new URL(source.url);
    if (certificate) {
      const route = JSON.stringify([entry.origin, certificate.host]);
      if (failedRoutes.has(route)) return { problem };
      failedRoutes.add(route);
    }
    reportFileRetry(deps, tabId, pageUrl, fromPopup);
    const fresh = await deps.generateDownload?.(tabId, pageUrl, control);
    if (!fresh || fresh.filenameHint !== offer.filename || !sameNamedResource(source.url, fresh.url)) return { problem };
    const next = new URL(fresh.url);
    if (next.protocol !== "https:" && (certificate || entry.origin !== next.origin)) return { problem };
    if (certificate ? next.host === certificate.host : tried.has(fresh.url)) return { problem };
    source = fresh;
    renewals++;
  }
  return { problem: describeFileSaveProblem(offer.filename, "download link") };
}

function sameNamedResource(left: string, right: string): boolean {
  const a = new URL(stableAddress(left));
  const b = new URL(stableAddress(right));
  return a.pathname === b.pathname && a.search === b.search;
}

export function registerDownloadBestCommand(commands: CommandsLike | undefined, deps: DownloadBestDeps): void {
  commands?.onCommand.addListener(command => {
    if (command === "download-best") void downloadBestForActiveTab(deps);
  });
}
