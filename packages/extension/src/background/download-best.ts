import type { JobError, StreamDescriptor } from "@savemedia/core";
import type { BestDownloadOutcome, NamedFile } from "./router";
import type { JobOrigin } from "./state/records";
import type {
  BackgroundToPopupMessage,
  FileDownloadOffer,
  FileSaveProblem,
  HotkeyFeedbackOutcome,
  LocalJobView,
} from "../types/messages";
import type { TabFacts } from "../types/page-facts";
import type { ProbeRequest, Selection } from "../selection/main-video";
import { failureToast } from "./hotkey-jobs";
import { downloadOptions } from "../util/downloadable";
import { expectedSize, sizeText } from "../util/expected-size";
import { canonicalAddress, offersFile } from "../util/media-address";
import { networkBlock, toastDetail } from "@savemedia/core";
import { AMBIGUOUS_PLAYING_HINT, COULD_NOT_START, HOTKEY, IMAGE_REFUSALS, UNREACHABLE_PAGE_HINT, siteText, waitingHint, withSize } from "../ui/text";
import { isDelegableError } from "../native/local-downloader";
import type { FileRecoveryResult } from "./interrupted-download";
import type { ImageSaveResult } from "./image-save";
import type { Logger } from "../util/logger";

interface ActiveTab {
  readonly id?: number | undefined;
  readonly url?: string | undefined;
}

export interface DownloadBestDeps {
  readonly logger?: Pick<Logger, "error">;
  readonly tabs: {
    readonly query: (queryInfo: { readonly active: true; readonly currentWindow: true }) => Promise<readonly ActiveTab[]>;
    readonly isOnPage?: (tabId: number, pageUrl: string) => Promise<boolean>;
  };
  /** Every frame's facts, collected now. */
  readonly collect: (tabId: number, options: { pointer: boolean; thumbnails: boolean }) => Promise<TabFacts>;
  /** The one selection for the tab, from what is known now. */
  readonly select: (tabId: number, facts: TabFacts, usePointer: boolean) => Selection;
  /** One bounded check of a source the page declares or an element holds. Asked for by the user's action. */
  readonly probe: (tabId: number, request: ProbeRequest, retryFailed: boolean) => Promise<void>;
  /** Verifies and saves an image. */
  /** `loaded`: the page shows the picture in an img element, so the browser itself was answered with it. */
  readonly saveImage?: (image: { readonly url: string; readonly pageUrl: string; readonly loaded: boolean; readonly tabId: number }) => Promise<ImageSaveResult>;
  /**
   * One save of an image at a time, and the one question before the same image is saved a second time in a
   * browser session, as for a video. Null: the image is being saved, the question is open, or the user
   * declined. `pageUrl` is the tab's page, where the question is asked; `name` is what the question calls
   * the image.
   */
  readonly reserveImage?: (tabId: number, pageUrl: string, image: PointedImage, name: string) => Promise<{ finish(saved: boolean): Promise<void> } | null>;
  readonly runtime: {
    readonly sendMessage: (msg: BackgroundToPopupMessage, cb?: () => void) => void;
  };
  readonly router: {
    readonly descriptors: (tabId: number) => readonly StreamDescriptor[];
    readonly snapshot?: (tabId: number) => Extract<BackgroundToPopupMessage, { type: "descriptors" }>;
    readonly startSelected: (tabId: number, ids: readonly StreamDescriptor["id"][], file?: NamedFile, origin?: JobOrigin,
      options?: { readonly allowRepeat?: boolean }) => Promise<BestDownloadOutcome>;
  };
  readonly recoverInterrupted?: (tabId: number, pageUrl: string, offer: FileDownloadOffer) => Promise<FileRecoveryResult>;
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
   * Alt+S on a tab whose page savemedia cannot read. Nothing is saved: the
   * popup, or the toolbar, says why and what to do.
   */
  readonly showUnreachable?: (tabId: number) => void;
}

/** The image under the pointer: its address, the address of the document that shows it, and whether that document shows the picture. */
export interface PointedImage { readonly url: string; readonly pageUrl: string; readonly loaded: boolean }

type BestDownloadStreamId = Extract<BestDownloadOutcome, { kind: "started" }>["streamId"];

export interface CommandsLike {
  readonly onCommand: {
    readonly addListener: (listener: (command: string) => void) => void;
  };
}

export interface Scan { readonly facts: TabFacts; readonly selection: Selection }

const PROBE_CONCURRENCY = 3;
const PROBE_ROUNDS = 2;

async function probeAll(deps: Pick<DownloadBestDeps, "probe">, tabId: number, requests: readonly ProbeRequest[], retryFailed: boolean): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < requests.length) {
      const request = requests[next++]!;
      await deps.probe(tabId, request, retryFailed).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, requests.length) }, worker));
}

/**
 * Collect the facts and select. Sources that only a check can confirm (what
 * an element holds, what the page declares) are checked in counted rounds,
 * never against a clock, and the selection is made again from what they gave.
 */
export async function scanTab(
  deps: Pick<DownloadBestDeps, "collect" | "select" | "probe">, tabId: number,
  options: { readonly pointer: boolean; readonly thumbnails: boolean; readonly retryFailed: boolean; readonly list: boolean;
    /** Called once, before the first check is sent: a check can take as long as a server takes to answer. */
    readonly onChecking?: () => void },
): Promise<Scan> {
  const facts = await deps.collect(tabId, { pointer: options.pointer, thumbnails: options.thumbnails });
  let selection = deps.select(tabId, facts, options.pointer);
  const asked = new Set<string>();
  let announced = false;
  const checking = (): void => {
    if (!announced) options.onChecking?.();
    announced = true;
  };
  // A source that failed its last check is checked again only on the user's own request to save or to look again.
  const due = (request: ProbeRequest): boolean => !asked.has(request.url) && (!request.retry || options.retryFailed);
  for (let round = 0; round < PROBE_ROUNDS; round++) {
    const requests = selection.toProbe.filter(due);
    if (!requests.length) break;
    for (const request of requests) asked.add(request.url);
    checking();
    await probeAll(deps, tabId, requests, options.retryFailed);
    selection = deps.select(tabId, facts, options.pointer);
  }
  if (options.list) {
    const requests = selection.listProbe.filter(due);
    if (requests.length) {
      checking();
      await probeAll(deps, tabId, requests, options.retryFailed);
      selection = deps.select(tabId, facts, options.pointer);
    }
  }
  return { facts, selection };
}

// One Alt+S press is one save. The browser's command and a key event the
// page received can both report the same press: they join the same run.
const hotkeyRuns = new Map<number, Promise<void>>();

export function saveFromHotkey(deps: DownloadBestDeps, tabId: number): Promise<void> {
  const running = hotkeyRuns.get(tabId);
  if (running) return running;
  const run = hotkeySave(deps, tabId).catch(error => {
    // The page is told that nothing started; why is for whoever reads the worker's log.
    deps.logger?.error("the save shortcut failed", { error: String(error) });
    deps.showHotkeyFeedback(tabId, "failed", HOTKEY.couldNotStart);
  }).finally(() => { if (hotkeyRuns.get(tabId) === run) hotkeyRuns.delete(tabId); });
  hotkeyRuns.set(tabId, run);
  return run;
}

/**
 * The tab's running Alt+S press no longer stands for the next one: the tab
 * shows another page, or the press ended in a question to the user. The run
 * itself goes on (an answered question still starts its save); the next
 * press is a press of its own and never waits behind it.
 */
export function forgetHotkeyRun(tabId: number): void {
  hotkeyRuns.delete(tabId);
  for (const [key, pending] of pendingFileLinks) if (pending.tabId === tabId) pendingFileLinks.delete(key);
}

export async function downloadBestForActiveTab(deps: DownloadBestDeps): Promise<void> {
  const [tab] = await deps.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await saveFromHotkey(deps, tab.id);
}

function topPage(facts: TabFacts) {
  const top = facts.frames.find(frame => frame.top);
  return top ? { url: top.url, state: top.page ?? null } : null;
}

/** The feedback for a started save, with the file's size when the source declares or implies it. */
function savingText(deps: DownloadBestDeps, tabId: number, streamId: string, text: string): string {
  const descriptor = deps.router.descriptors(tabId).find(item => item.id === streamId);
  if (!descriptor) return text;
  const size = expectedSize(descriptor, downloadOptions(descriptor)[0]?.variant ?? descriptor.variants[0]);
  return withSize(text, size ? sizeText(size) : null);
}

/** The streams that are being saved now. A second press on one of them starts nothing new, and says so. */
function runningJobs(deps: DownloadBestDeps, tabId: number): ReadonlySet<string> {
  const statuses = deps.router.snapshot?.(tabId).statuses ?? {};
  return new Set(Object.entries(statuses).flatMap(([id, status]) => status.phase === "active" ? [id] : []));
}

/** What the repeat question calls an image: the last part of its address, when it has one. */
function imageName(url: string): string {
  if (!/^https?:/i.test(url)) return HOTKEY.image;
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "") || HOTKEY.image;
  } catch { return HOTKEY.image; }
}

/**
 * Alt+S on an image. `pageUrl` is the tab's page. The same image is saved once: a press while it is being
 * saved starts nothing, and a press after it was saved asks before a second copy is made (rule 11).
 */
export async function saveImageAtPointer(deps: DownloadBestDeps, tabId: number, pageUrl: string, image: PointedImage): Promise<void> {
  if (!deps.saveImage) {
    deps.showHotkeyFeedback(tabId, "failed", HOTKEY.imagePageOnly);
    return;
  }
  const permit = deps.reserveImage ? await deps.reserveImage(tabId, pageUrl, image, imageName(image.url)) : undefined;
  if (permit === null) return;
  deps.showHotkeyFeedback(tabId, "started", HOTKEY.image);
  const result = await deps.saveImage({ ...image, tabId }).catch((): ImageSaveResult => ({ kind: "failed", error: null }));
  // The receipt is written only for a file the browser reported complete.
  await permit?.finish(result.kind === "saved").catch(() => undefined);
  // The tab shows another page by now: a word about the old page's image does not belong on it.
  if (result.kind === "left-page") return;
  if (result.kind === "saved") deps.showHotkeyFeedback(tabId, "complete", result.filename);
  else if (result.kind === "refused") deps.showHotkeyFeedback(tabId, "failed", IMAGE_REFUSALS[result.received]);
  else if (result.kind === "page-only") deps.showHotkeyFeedback(tabId, "failed", HOTKEY.imagePageOnly);
  else if (result.kind === "local-network") deps.showHotkeyFeedback(tabId, "failed", HOTKEY.imageLocalNetwork);
  else deps.showHotkeyFeedback(tabId, "failed", imageFailure(result.error));
}

/**
 * An image that did not arrive is said as that. The failure's own text speaks of the video's server, so it
 * is used only where it says more: a refusal by status, a file that is too large, or the browser's own
 * account of a block by the user's network.
 */
function imageFailure(error: JobError | null): string {
  if (!error) return HOTKEY.imageNotSent;
  if (error.code === "network_unreachable"
    && !(error.browserDiagnostic && networkBlock(error.browserDiagnostic, { answeredWithPage: false }))) return HOTKEY.imageNotSent;
  return failureToast(error);
}

/** What a selection leads to when Save is asked: a started job, a refusal with its reason, or nothing to do yet. */
type SaveResult =
  | BestDownloadOutcome
  | { readonly kind: "waiting"; readonly detail: string }
  | { readonly kind: "nothing"; readonly detail: string; readonly delegable: boolean };

async function saveSelection(deps: DownloadBestDeps, tabId: number, pageUrl: string, selection: Selection, origin: JobOrigin,
  options: { readonly allowRepeat?: boolean } = {}): Promise<SaveResult> {
  const hint = selection.state === "ambiguous" && selection.targetPlaying ? AMBIGUOUS_PLAYING_HINT : waitingHint(selection.state);
  if (hint) return { kind: "waiting", detail: hint };
  // A site that is read by a site reader alone: nothing to wait for, and the reason is said. The user's own
  // Local downloader fallback applies as for any page where savemedia has nothing to save.
  const site = siteText(selection.state);
  if (site) return { kind: "nothing", detail: site, delegable: true };
  if (selection.state === "failed" && selection.failure) {
    return { kind: "failed", streamId: `discovery:${tabId}` as BestDownloadStreamId, error: selection.failure.error };
  }
  if (selection.state === "no-media" || !selection.candidates.length) {
    if (selection.state === "protected") {
      // The element used a key before anything of it was captured.
      const error: JobError = { code: "cdm_required", severity: "terminal", keySystem: selection.keySystem ?? "unknown", detectedVia: ["eme-hook"] };
      return { kind: "failed", streamId: `discovery:${tabId}` as BestDownloadStreamId, error };
    }
    return selection.streamSource ? { kind: "nothing", detail: HOTKEY.streamSource, delegable: false }
      : { kind: "nothing", detail: HOTKEY.noMedia, delegable: true };
  }
  const outcome = await deps.router.startSelected(tabId, selection.candidates,
    selection.mainName ? { pageUrl, filename: selection.mainName } : undefined, origin, options);
  return outcome.kind === "no-media" ? { kind: "nothing", detail: HOTKEY.noMedia, delegable: true } : outcome;
}

/** Protected, live and waiting states are never handed to the local downloader. */
function delegable(selection: Selection, result: SaveResult): boolean {
  if (result.kind === "nothing") return result.delegable;
  if (result.kind !== "failed") return false;
  return (selection.state === "failed" || selection.state === "unsupported" || selection.state === "ready") && isDelegableError(result.error);
}

/**
 * Alt+S: save the video or image under the pointer. With the pointer over
 * neither, the page's main video is saved, as the popup shows it.
 */
async function hotkeySave(deps: DownloadBestDeps, tabId: number): Promise<void> {
  // Pressing Alt+S is the user's request to save now: what failed before is checked again.
  // A source that has to be checked first can take as long as its server takes to answer: the page says
  // "Checking" before the first check is sent, so no press is followed by silence.
  const { facts, selection } = await scanTab(deps, tabId, { pointer: true, thumbnails: false, retryFailed: true, list: false,
    onChecking: () => deps.showHotkeyFeedback(tabId, "preparing", HOTKEY.checking) });
  if (!facts.reachable) {
    // Without the page's own facts there is no pointer target and no ad or key signal: nothing is saved,
    // also when a request of the page was already seen. The same press after a reload decides with all of them.
    if (deps.showUnreachable) deps.showUnreachable(tabId);
    else deps.showHotkeyFeedback(tabId, "failed", UNREACHABLE_PAGE_HINT);
    return;
  }
  const page = topPage(facts)!;
  if (selection.image) return saveImageAtPointer(deps, tabId, page.url, selection.image);
  // A page that names a file and declares its link means that file, also
  // with the pointer on a preview player of it. A page that names no file
  // has no such offer: there the selection decides.
  const offer = page.state?.fileDownload;
  if (offer) return saveDeclaredFile(deps, tabId, page.url, offer, false);

  const running = runningJobs(deps, tabId);
  const result = await saveSelection(deps, tabId, page.url, selection, "hotkey");
  if (result.kind === "skipped") return;
  if (result.kind === "started") {
    // The same press on the same video changes nothing: the save that runs is the save.
    const saving = savingText(deps, tabId, result.streamId, selection.reason === "pointer" ? HOTKEY.thisVideo : HOTKEY.bestQuality);
    // The page names a file that is none of what the browser received: what is saved is not that file, and the toast says so.
    deps.showHotkeyFeedback(tabId, "started", running.has(result.streamId) ? HOTKEY.alreadyRunning
      : selection.namedPending ? `${saving}. ${HOTKEY.notTheNamedFile}` : saving);
    return;
  }
  if (result.kind === "waiting") {
    deps.showHotkeyFeedback(tabId, "waiting", result.detail);
    return;
  }
  if (delegable(selection, result) && deps.localFallback && page.url) {
    const job = await deps.localFallback(page.url, tabId);
    if (job) {
      deps.showHotkeyFeedback(tabId, "delegated", HOTKEY.delegated);
      return;
    }
  }
  if (result.kind === "nothing") {
    deps.showHotkeyFeedback(tabId, "no-media", result.detail);
    return;
  }
  if (result.kind !== "failed") return;
  deps.showHotkeyFeedback(tabId, "failed", failureToast(result.error));
  deps.runtime.sendMessage({ type: "job-failed", streamId: result.streamId, error: result.error }, () => undefined);
}

/**
 * Why the popup's Save did not get as far as a save. unreachable: the page's
 * own script does not answer, so nothing is known about the page.
 * page-changed: the tab shows another page than the popup did, and nothing of
 * the clicked card is left.
 */
export type PopupSaveStop = "unreachable" | "page-changed";

/** An address without its fragment: the part that names a page. */
function pageOf(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

/**
 * The popup's Save on the main card: the same selection, without the pointer
 * and without toasts. `ids` are the streams of the card the user clicked.
 * When the page has moved on since the popup last looked (a feed advanced,
 * the next video started, the page rewrote its own address), the clicked
 * card is still what is saved: its streams are still this tab's. A save that
 * cannot start answers why, so the popup never leaves a click without a word.
 */
export async function saveFromPopup(deps: DownloadBestDeps, tabId: number, pageUrl: string, ids: readonly StreamDescriptor["id"][] = [],
  options: { readonly allowRepeat?: boolean } = {}): Promise<PopupSaveStop | null> {
  const { facts, selection } = await scanTab(deps, tabId, { pointer: false, thumbnails: false, retryFailed: true, list: false });
  const page = topPage(facts);
  if (!page) return "unreachable";
  const known = new Set(deps.router.descriptors(tabId).map(descriptor => descriptor.id));
  const clicked = ids.filter(id => known.has(id));
  // The address the popup showed and the page's address now. A fragment names a place inside the same page.
  const samePage = pageOf(page.url) === pageOf(pageUrl);
  if (!samePage && !clicked.length) return "page-changed";
  // A file the page names belongs to the page the popup showed, not to one the tab moved on to.
  const offer = samePage ? page.state?.fileDownload : undefined;
  if (offer) {
    await saveDeclaredFile(deps, tabId, page.url, offer, true, options);
    return null;
  }
  const moved = clicked.length > 0 && !(selection.main !== null && clicked.includes(selection.main));
  const result: SaveResult = moved ? await deps.router.startSelected(tabId, clicked, undefined, "popup", options)
    : await saveSelection(deps, tabId, page.url, selection, "popup", options);
  if (result.kind === "failed") deps.runtime.sendMessage({ type: "job-failed", streamId: result.streamId, error: result.error });
  return null;
}

async function saveDeclaredFile(deps: DownloadBestDeps, tabId: number, pageUrl: string, offer: FileDownloadOffer, fromPopup: boolean,
  options: { readonly allowRepeat?: boolean } = {}): Promise<void> {
  await deps.rememberFileSaveProblem?.(tabId, pageUrl, null);
  if (!fromPopup) deps.showHotkeyFeedback(tabId, "preparing", offer.filename);
  const running = runningJobs(deps, tabId);
  const result = await startFilePageDownload(deps, tabId, pageUrl, offer, fromPopup ? "popup" : "hotkey", options);
  if (!result) return;
  if ("problem" in result) {
    if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, pageUrl)) return;
    await deps.rememberFileSaveProblem?.(tabId, pageUrl, result.problem);
    // The same words the popup's file row leads with.
    deps.showHotkeyFeedback(tabId, "failed", result.problem.error ? failureToast(result.problem.error) : toastDetail(COULD_NOT_START));
    return;
  }
  if (fromPopup) return;
  deps.showHotkeyFeedback(tabId, "started", running.has(result.streamId) ? HOTKEY.alreadyRunning
    : savingText(deps, tabId, result.streamId, HOTKEY.bestQuality));
}

type FilePageResult = Extract<BestDownloadOutcome, { kind: "started" }> | { problem: FileSaveProblem } | null;
const pendingFileLinks = new Map<string, { readonly tabId: number; readonly result: Promise<FilePageResult> }>();

function startFilePageDownload(
  deps: DownloadBestDeps, tabId: number, pageUrl: string, offer: FileDownloadOffer, origin: JobOrigin,
  options: { readonly allowRepeat?: boolean } = {},
): Promise<FilePageResult> {
  // A popup click and a shortcut can overlap before either has a stream ID.
  const key = JSON.stringify([tabId, pageUrl, offer.filename, offer.url]);
  const pending = pendingFileLinks.get(key);
  if (pending) return pending.result;
  const entry = { tabId, result: saveFileLink(deps, tabId, pageUrl, offer, origin, options).finally(() => {
    if (pendingFileLinks.get(key) === entry) pendingFileLinks.delete(key);
  }) };
  pendingFileLinks.set(key, entry);
  return entry.result;
}

/** Save the link the page declares for its named file, after Chrome's own resume of an earlier attempt. */
async function saveFileLink(
  deps: DownloadBestDeps, tabId: number, pageUrl: string, offer: FileDownloadOffer, origin: JobOrigin,
  options: { readonly allowRepeat?: boolean } = {},
): Promise<FilePageResult> {
  const recovered = await deps.recoverInterrupted?.(tabId, pageUrl, offer);
  if (recovered) {
    if ("problem" in recovered) return recovered;
    if (recovered.handled === "saved") deps.showHotkeyFeedback(tabId, "complete", offer.filename);
    return null;
  }
  const snapshot = deps.router.snapshot?.(tabId);
  const retained = snapshot?.descriptors.some(d => d.pageUrl === pageUrl && !d.drm && offersFile(d, offer.url)
    && snapshot.statuses?.[d.id]?.fileName === offer.filename
    && snapshot.statuses[d.id]?.phase === "failed" && !!snapshot.statuses[d.id]?.retained);
  // A failed check of this link is checked again: saving is the user's retry.
  if (!retained) {
    await deps.probe(tabId, { url: offer.url, frameId: 0, documentId: null, frameUrl: pageUrl, scope: "page", via: "file-link",
      retry: true, filenameHint: offer.filename }, true);
  }
  if (deps.tabs.isOnPage && !await deps.tabs.isOnPage(tabId, pageUrl)) return null;
  const ids = deps.router.descriptors(tabId).filter(d => offersFile(d, offer.url)).map(d => d.id);
  const failure = deps.router.snapshot?.(tabId).failures?.find(item => canonicalAddress(item.url) === canonicalAddress(offer.url));
  // One failure has one explanation, wherever it was met: the popup writes it from the error.
  if (!ids.length) return { problem: { filename: offer.filename, stage: "checking", error: failure?.error ?? null } };
  const outcome = await deps.router.startSelected(tabId, ids, { pageUrl, filename: offer.filename }, origin, options);
  if (outcome.kind === "skipped") return null;
  if (outcome.kind === "started") return outcome;
  return { problem: { filename: offer.filename, stage: "starting", error: outcome.kind === "failed" ? outcome.error : null } };
}

export { isAltSShortcut } from "../util/shortcut";

/** `ready`: the worker's stored state is back in memory. A command that started the worker waits for it. */
export function registerDownloadBestCommand(commands: CommandsLike | undefined, deps: DownloadBestDeps, ready: Promise<void> = Promise.resolve(),
  logger?: Pick<Logger, "error">): void {
  commands?.onCommand.addListener(command => {
    if (command !== "download-best") return;
    void ready.then(() => downloadBestForActiveTab(deps)).catch(error => logger?.error("the save shortcut failed", { error: String(error) }));
  });
}
