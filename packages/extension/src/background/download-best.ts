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
  type FileSaveState,
  type HotkeyFeedbackOutcome,
  type LocalJobView,
  type PopupToBackgroundMessage,
} from "../types/messages";
import { relayHost } from "../engine/relay-config";
import { hotkeyErrorDetail } from "./hotkey-jobs";
import { describeFileSaveProblem } from "./file-save-problem";
import { renewableResource } from "../util/media-address";
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
    readonly startBestDownload: (tabId: number, file?: NamedFile) => Promise<BestDownloadOutcome>;
    readonly setDiscoveryScope: (tabId: number, pageUrl: string, urls: readonly string[]) => void;
  };
  readonly handleCapture: (tabId: number, msg: CaptureMessage, observedUrl?: string, referrerPage?: string) => Promise<void>;
  readonly generateDownload?: (tabId: number, pageUrl: string, offer: FileDownloadOffer) => Promise<DiscoveredMedia | null>;
  readonly relayFile?: (tabId: number, pageUrl: string, offer: FileDownloadOffer, source: DiscoveredMedia) => Promise<{saved: string} | {error: string; code?: string} | null>;
  readonly allowRelayForSite?: (pageUrl: string) => Promise<void>;
  readonly relayAllowedForSite?: (pageUrl: string) => Promise<boolean>;
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
  const offer = discovery?.fileDownload;
  let outcome = offer
    ? await deps.router.startBestDownload(tabId, { pageUrl: discovery.pageUrl, ...offer })
    : await deps.router.startBestDownload(tabId);
  if (outcome.kind === "skipped") return;
  if (offer && outcome.kind === "failed" && outcome.error.code === "access_denied" && outcome.error.httpStatus !== 403) {
    const problem = describeFileSaveProblem(offer.filename, "file connection", outcome.error);
    await deps.rememberFileSaveProblem?.(tabId, discovery.pageUrl, problem);
    deps.showHotkeyFeedback(tabId, "failed", problem.title);
    return;
  }
  if (offer && (outcome.kind === "no-media" || (outcome.kind === "failed" && outcome.duringDiscovery))) {
    if (outcome.kind === "failed") reportFileRetry(deps, tabId, discovery.pageUrl, fromPopup);
    else if (!fromPopup) deps.showHotkeyFeedback(tabId, "preparing", "Checking the site’s download link");
    await deps.rememberFileSaveProblem?.(tabId, discovery.pageUrl, null);
    const result = await startFilePageDownload(deps, tabId, discovery.pageUrl, offer, { fromPopup });
    if (!result) return;
    if ("saved" in result) {
      deps.showHotkeyFeedback(tabId, "complete", result.saved);
      return;
    }
    if ("problem" in result) {
      if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, discovery.pageUrl)) return;
      await deps.rememberFileSaveProblem?.(tabId, discovery.pageUrl, result.problem);
      deps.showHotkeyFeedback(tabId, "failed", result.problem.resourceFingerprint && relayHost
        ? "Open SaveMedia to try the secure relay." : `${result.problem.title}. Open SaveMedia for details.`);
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

type FilePageResult = Extract<BestDownloadOutcome, { kind: "started" }> | { problem: FileSaveProblem } | { saved: string } | null;
const pendingFileLinks = new Map<string, Promise<FilePageResult>>();

export async function handleFileConnectionChoice(
  deps: DownloadBestDeps, choice: Extract<PopupToBackgroundMessage, { type: "file-connection-choice" }>, state: FileSaveState | null,
): Promise<void> {
  const { tabId, pageUrl, filename } = choice;
  const warning = state?.fileSaveProblem;
  if (warning?.code !== "tls_certificate_rejected" || warning.filename !== filename) return;
  if (!choice.retry) {
    await deps.rememberFileSaveProblem?.(tabId, pageUrl, null);
    return;
  }
  const offer = state?.fileDownload;
  if (offer?.filename === filename && warning.resourceFingerprint && deps.relayFile) await deps.allowRelayForSite?.(pageUrl);
  const result = offer?.filename === filename && warning.resourceFingerprint
    ? await startFilePageDownload(deps, tabId, pageUrl, offer, { fromPopup: true, expectedFingerprint: warning.resourceFingerprint })
    : { problem: describeFileSaveProblem(filename, "download link") };
  if (!result || (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, pageUrl))) return;
  if ("problem" in result) {
    const problem = result.problem.code === "tls_certificate_rejected"
      ? { ...result.problem, code: "secure_retry_failed", title: "File wasn’t saved",
        body: "The browser still couldn’t verify the connection to the file server." }
      : result.problem;
    await deps.rememberFileSaveProblem?.(tabId, pageUrl, problem);
    deps.showHotkeyFeedback(tabId, "failed", problem.title);
    return;
  }
  if ("saved" in result) {
    deps.showHotkeyFeedback(tabId, "complete", result.saved);
    return;
  }
  deps.trackHotkeyJob?.(result.streamId, tabId);
  await deps.rememberFileSaveProblem?.(tabId, pageUrl, null);
}

interface FileSaveAttempt {
  readonly fromPopup: boolean;
  readonly expectedFingerprint?: string;
}

function reportFileRetry(deps: DownloadBestDeps, tabId: number, pageUrl: string, fromPopup: boolean): void {
  if (fromPopup) deps.runtime.sendMessage({ type: "retrying-file-link", tabId, pageUrl });
  else deps.showHotkeyFeedback(tabId, "retrying", "Trying the site’s download link");
}

function startFilePageDownload(
  deps: DownloadBestDeps, tabId: number, pageUrl: string, offer: FileDownloadOffer, options: FileSaveAttempt,
): Promise<FilePageResult> {
  // A popup click and a shortcut can overlap before either has a stream ID.
  const key = JSON.stringify([tabId, pageUrl, offer.filename, offer.linkedPage, options.expectedFingerprint]);
  const pending = pendingFileLinks.get(key);
  if (pending) return pending;
  const starting = resolveAndStartFileDownload(deps, tabId, pageUrl, offer, options).finally(() => pendingFileLinks.delete(key));
  pendingFileLinks.set(key, starting);
  return starting;
}

async function resolveAndStartFileDownload(
  deps: DownloadBestDeps, tabId: number, pageUrl: string, offer: FileDownloadOffer, { expectedFingerprint, fromPopup }: FileSaveAttempt,
): Promise<FilePageResult> {
  let source = await deps.generateDownload?.(tabId, pageUrl, offer);
  if (!source) return { problem: describeFileSaveProblem(offer.filename, "download link") };

  const fingerprint = await fileFingerprint(source.url);
  if (expectedFingerprint && (new URL(source.url).protocol !== "https:" || fingerprint !== expectedFingerprint)) {
    return { problem: { filename: offer.filename, stage: "download link", code: "https_link_unavailable",
      title: "File wasn’t saved", body: "The site didn’t supply a matching HTTPS link for this file." } };
  }
  async function saveByRelay(media: DiscoveredMedia): Promise<FilePageResult> {
    if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, pageUrl)) return null;
    const result = await deps.relayFile!(tabId, pageUrl, offer, media);
    if (!result || "saved" in result) return result;
    return {problem: {filename: offer.filename, stage: "file transfer", code: result.code ?? "relay_transfer_failed",
      title: "File wasn’t saved", body: result.error}};
  }
  if (expectedFingerprint && deps.relayFile) return saveByRelay(source);
  const rejectedHosts = new Set<string>();
  const failedRedirects = new Set<string>();
  const triedUrls = new Set<string>();
  for (let renewals = 0; ; renewals++) {
    triedUrls.add(source.url);
    await probeSource(deps, tabId, pageUrl, source, offer.linkedPage);
    if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, pageUrl)) return null;
    // A passive scan may have changed scope while the probe was in flight.
    // Select the address actually issued by the site's download control.
    deps.router.setDiscoveryScope(tabId, pageUrl, [source.url]);
    const outcome = await deps.router.startBestDownload(tabId, { pageUrl, ...offer });
    if (outcome.kind === "skipped") return null;
    if (outcome.kind === "started") return outcome;

    const error = outcome.kind === "failed" ? outcome.error : undefined;
    const stage = outcome.kind === "failed" && !outcome.duringDiscovery ? "start download" : "file connection";
    const certificate = error?.code === "tls_certificate_rejected" && stage === "file connection" ? error.browserDiagnostic : null;
    const failure = describeFileSaveProblem(offer.filename, stage, error);
    const problem = certificate ? { ...failure, resourceFingerprint: fingerprint } : failure;
    const renewableLink = stage === "file connection" && error?.code === "access_denied" && error.httpStatus === 403
      && renewableResource(source.url) !== null;
    if (certificate && new URL(source.url).protocol === "https:" && deps.relayFile && await deps.relayAllowedForSite?.(pageUrl)) {
      return saveByRelay(source);
    }
    if ((!certificate && !renewableLink) || renewals >= MAX_LINK_RENEWALS) return { problem };

    const entry = new URL(source.url);
    if (certificate) {
      rejectedHosts.add(certificate.host);
      // A healthy entry can redirect to another host on its next request.
      // Stop if that entry leads back to the same rejected host twice.
      const route = JSON.stringify([entry.origin, certificate.host]);
      if (failedRedirects.has(route)) return { problem };
      failedRedirects.add(route);
    }
    reportFileRetry(deps, tabId, pageUrl, fromPopup);
    const refreshed = await deps.generateDownload?.(tabId, pageUrl, offer);
    if (!refreshed || await fileFingerprint(refreshed.url) !== fingerprint) return { problem };
    const next = new URL(refreshed.url);
    if (next.protocol !== "https:" && (certificate || next.origin !== entry.origin)) return { problem };
    if (rejectedHosts.has(next.host) || (!certificate && triedUrls.has(refreshed.url))) return { problem };
    source = refreshed;
  }
}

// Some sites issue a distinct token on every request, even while the file is unavailable.
const MAX_LINK_RENEWALS = 3;

// Keep the file identity across popup closure without storing a signed URL.
async function fileFingerprint(url: string): Promise<string> {
  const resource = new URL(renewableResource(url) ?? url);
  resource.searchParams.sort();
  const bytes = new TextEncoder().encode(resource.pathname + resource.search);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function registerDownloadBestCommand(commands: CommandsLike | undefined, deps: DownloadBestDeps): void {
  commands?.onCommand.addListener(command => {
    if (command === "download-best") void downloadBestForActiveTab(deps);
  });
}
