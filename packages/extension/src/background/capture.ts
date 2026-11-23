import { addressScope, beginsWholeMediaFile, classify, findMp4Protection, hasMatroskaEncryption, isJobError, isRetryableStatus, manifestTooLarge, type DrmStatus, type JobError, type Presentation } from "@savemedia/core";
import type { AudioRenditionId, StreamDescriptor, Variant, VariantId } from "@savemedia/core";
import type { AdVia, BridgeToBackgroundMessage, DiscoveryFailure } from "../types/messages";
import type { Logger } from "../util/logger";
import { originalMediaFilename } from "../util/filename";
import { declaredTotalBytes } from "../util/expected-size";
import { observeFetch, type HttpObservation } from "../util/http-diagnostics";
import { hlsInterstitials } from "../util/ad-signals";
import { reachedLocallyByName, unobservedLocalTarget } from "../util/address-space";
import { MAX_ADDRESS_LENGTH, mimeKind, normalizeMediaUrl, playlistIdentity, urlKind } from "../util/media-url";
import { MAX_ROW_BYTES, rowBytes, thinDescriptor } from "../util/thin-descriptor";
import { DIRECT_MEDIA_TYPES, requireDirectVideo } from "../engine/verify-direct";
import { checkResponseStatus, probeMedia, readBytes, recoverRequest, responseHeaders, rangeFailure, type MediaProbe, type ProbeFetch, type ProbeResponse, type ProbeInit } from "../engine/net/range-recovery";
import { isTransferError } from "../engine/net/transfer-error";
import { readManifestText } from "../engine/net/manifest-text";
import type { Origin } from "./tab-media";

export type CaptureMessage = Extract<BridgeToBackgroundMessage, { type: "capture" }>;

/** The slice of a fetch Response the capture probe actually reads. */
export interface CaptureFetchResponse extends ProbeResponse {
  text(): Promise<string>;
}

export interface CaptureOptions {
  /** The address the response came from, when the page's request was redirected. */
  readonly observedUrl?: string;
  /** The document that made the request: its origin is the Referer the probe mirrors. */
  readonly referrerPage?: string;
  /** Where the address was seen. The route generation is stamped when the capture starts. */
  readonly origin?: Omit<Origin, "generation">;
  /** Check again an address that failed on this route: "Check page again". */
  readonly retryFailed?: boolean;
  /**
   * "include" only for an address the browser itself received in this tab, or
   * one the user asked to check. Anything else is requested without cookies.
   */
  readonly credentials?: "include" | "omit";
  /** The server address the browser connected to for this address, when known. */
  readonly serverIp?: string | null;
  /** A check the user asked for: it goes ahead of the checks of what the page merely loaded. */
  readonly priority?: boolean;
  /**
   * The headers of the answer the browser itself received for this address, when this call reports such
   * an answer. An address named as an ad is listed from them alone.
   */
  readonly observedHeaders?: Readonly<Record<string, string>>;
  /**
   * The user asked to save this listed ad. Only then is an address named as an ad requested: on its own,
   * savemedia never requests one.
   */
  readonly adRequested?: boolean;
  /**
   * The address is an answer a page's script fetched, and it is asked whether that is a whole file the
   * page plays from memory. Only a whole file is listed. A part of a stream (an init section, a
   * fragment), anything that is no video, and a check that fails for any reason are let go without a
   * word: they are no failed source, and the address is not asked about again.
   */
  readonly wholeFile?: boolean;
}

export interface CaptureDeps {
  readonly fetchFn: (
    url: string,
    init: ProbeInit,
  ) => Promise<CaptureFetchResponse>;
  /** Receives every descriptor that passed the surfacing gate. */
  readonly onDescriptor: (tabId: number, descriptor: StreamDescriptor, origin: Origin | null) => void;
  readonly onFailure?: (tabId: number, failure: DiscoveryFailure, origin: Origin | null) => void;
  readonly onProbeSuccess?: (tabId: number, url: string) => void;
  /** A check with `wholeFile` found a part of a stream or no video at all, or failed: the address is not asked about again. */
  readonly onPart?: (tabId: number, url: string) => void;
  readonly onHttp?: (tabId: number, observation: HttpObservation) => void;
  /**
   * Where the request behind a response of fetchFn went, as far as the browser reported it: each address
   * requested on the way, with the server address that answered it.
   */
  readonly serverHops?: (response: object) => readonly { readonly url: string; readonly ip: string }[];
  /**
   * The failure with what the browser reported about the check's own request: the address the server
   * answered from and a redirect to another host. `response` is the answer the failure is about, when
   * there was one. It reads the browser's report; it requests nothing.
   */
  /** `addressesSayNothing`: the server addresses the browser reports for this tab say nothing about the server (see check). */
  readonly explain?: (error: JobError, response: object | null, url: string, signal: AbortSignal, addressesSayNothing: boolean) => Promise<JobError>;
  /**
   * Settles before the first request, so hotlink-protected hosts see the
   * page's Referer. `holder` names this check: the rule stays as it is until
   * releaseReferer(holder), so another page's check cannot switch it in between.
   */
  readonly mirrorReferer?: (url: string, pageUrl: string, holder: string) => Promise<void>;
  readonly releaseReferer?: (holder: string) => void;
  /** Whether a page's ad response named this address. Such an address is requested only when the user saves it. */
  readonly isAd?: (tabId: number, url: string) => boolean;
  /**
   * Whether the browser itself received an answer from this address's origin at an address inside the
   * user's network, in this tab. Read at the moment of each decision, from the browser's own request events.
   */
  readonly observedLocal?: (tabId: number, url: string) => boolean;
  readonly generation?: (tabId: number, frameId: number) => number;
  /** A known address was seen again: note where, without another request. */
  readonly onSeen?: (tabId: number, url: string, origin: Origin) => void;
  /** Interstitial assets a media playlist schedules. Marked, never requested. */
  readonly onAds?: (tabId: number, urls: readonly string[], via: AdVia, assetLists: readonly string[], frameId: number) => void;
  readonly onTimeline?: (tabId: number, url: string, presentation: Presentation) => void;
  readonly logger?: Logger;
}

export type CaptureHandler = ((tabId: number, msg: CaptureMessage, options?: CaptureOptions) => Promise<void>) & {
  clearTab(tabId: number): void;
  /** Stop a running check of this address: it was marked as an ad. What the browser received of it is listed as it is. */
  abortUrl(tabId: number, url: string): void;
  /** Forget what is known about these addresses, so a new document checks them again. */
  forget(tabId: number, urls: readonly string[]): void;
};

/** What a tab already knows about an address, so the same request, reload or rescan costs one lookup. */
type Known =
  | { readonly kind: "descriptor"; readonly named: boolean; readonly group: string | null }
  | { readonly kind: "failure"; readonly generation: number }
  /** An ad, listed from the browser's own answer. It was never checked. */
  | { readonly kind: "observed" };

interface Pending {
  readonly promise: Promise<void>; readonly controller: AbortController; readonly urls: readonly string[];
  /** Lists the address from the browser's own answer, when the check began with one. */
  readonly listObserved: (() => void) | null;
}
interface TabCaptures {
  readonly controller: AbortController; readonly pending: Map<string, Pending>; readonly known: Map<string, Known>;
  /** Checks of what the page loaded: how many run, how many of each frame, and the ones waiting for a free place. */
  running: number;
  readonly frames: Map<number, number>;
  readonly waiting: { readonly frameId: number; readonly begin: () => void }[];
  /** Checks the user asked for have places of their own. */
  asked: number;
  readonly askedWaiting: (() => void)[];
}

const MAX_KNOWN = 512;
/** The response headers a row is classified from and keeps. */
const CLASSIFIED_HEADERS: readonly string[] = ["content-type", "content-disposition", "content-length", "content-range", "content-encoding", "etag", "last-modified"];
/** Checks of what a page loaded that one tab runs at the same time. A page that loads hundreds of media files is checked a few at a time. */
export const MAX_TAB_PROBES = 6;
/** Of those, the most that one frame's requests may take: a frame with slow servers leaves the other frames their places. */
export const MAX_FRAME_PROBES = 4;
/** Checks one tab may have waiting. Beyond it a passive capture is dropped: the page's next request for it is a new chance. */
export const MAX_WAITING_PROBES = 200;
/** Checks the user asked for (the popup, Alt+S) that one tab runs at the same time. They never wait behind the others. */
export const MAX_ASKED_PROBES = 4;
/**
 * A playlist or manifest is read whole while it keeps arriving at least this
 * fast: so many bytes within each stall window. A server that sends a byte
 * now and then is let go after one window.
 */
const MANIFEST_WINDOW_BYTES = 256 * 1024;

type Lane = { readonly asked: true } | { readonly asked: false; readonly frameId: number };

/** Start the waiting checks that have a place now: the frame with the fewest running goes first, oldest first within it. */
function startWaiting(state: TabCaptures): void {
  while (state.running < MAX_TAB_PROBES) {
    let next = -1;
    let fewest = MAX_FRAME_PROBES;
    for (let index = 0; index < state.waiting.length; index++) {
      const running = state.frames.get(state.waiting[index]!.frameId) ?? 0;
      if (running < fewest) { next = index; fewest = running; }
    }
    if (next < 0) return;
    state.waiting.splice(next, 1)[0]!.begin();
  }
}

/** Run `task` when its lane has a free place. Null when the tab already has too many passive checks waiting. */
function limited<T>(state: TabCaptures, lane: Lane, task: () => Promise<T>): Promise<T> | null {
  if (lane.asked) {
    const run = (): Promise<T> => {
      state.asked++;
      return task().finally(() => {
        state.asked--;
        state.askedWaiting.shift()?.();
      });
    };
    if (state.asked < MAX_ASKED_PROBES) return run();
    return new Promise<T>((resolve, reject) => { state.askedWaiting.push(() => { run().then(resolve, reject); }); });
  }
  const { frameId } = lane;
  const run = (): Promise<T> => {
    state.running++;
    state.frames.set(frameId, (state.frames.get(frameId) ?? 0) + 1);
    return task().finally(() => {
      state.running--;
      const left = (state.frames.get(frameId) ?? 1) - 1;
      if (left > 0) state.frames.set(frameId, left); else state.frames.delete(frameId);
      startWaiting(state);
    });
  };
  if (state.running < MAX_TAB_PROBES && (state.frames.get(frameId) ?? 0) < MAX_FRAME_PROBES) return run();
  if (state.waiting.length >= MAX_WAITING_PROBES) return null;
  return new Promise<T>((resolve, reject) => { state.waiting.push({ frameId, begin: () => { run().then(resolve, reject); } }); });
}

export function createCaptureHandler(deps: CaptureDeps): CaptureHandler {
  const tabs = new Map<number, TabCaptures>();
  let probes = 0;
  function clearTab(tabId: number): void {
    const state = tabs.get(tabId);
    state?.controller.abort();
    tabs.delete(tabId);
  }
  function abortUrl(tabId: number, url: string): void {
    const identity = playlistIdentity(url);
    for (const pending of tabs.get(tabId)?.pending.values() ?? []) {
      if (!pending.urls.includes(identity)) continue;
      pending.controller.abort();
      pending.listObserved?.();
    }
  }
  function remember(state: TabCaptures, identity: string, known: Known): void {
    state.known.delete(identity);
    state.known.set(identity, known);
    if (state.known.size > MAX_KNOWN) state.known.delete(state.known.keys().next().value!);
  }
  /**
   * An address a page's ad response named, as the browser itself received it. Nothing is requested: the
   * row says what the answer's headers say, and is marked as not checked.
   */
  async function listObserved(tabId: number, state: TabCaptures, cap: CaptureMessage["payload"], url: string, origin: Origin | null,
    options: CaptureOptions): Promise<void> {
    const identity = playlistIdentity(url);
    const known = state.known.get(identity);
    // Listed already, from this answer or from a check made before the address was named as an ad: note where it was seen again.
    if (known && known.kind !== "failure") {
      if (origin) deps.onSeen?.(tabId, url, origin);
      return;
    }
    if (!options.observedHeaders) return;
    remember(state, identity, { kind: "observed" });
    const headers = Object.fromEntries(Object.entries(options.observedHeaders).filter(([name]) => CLASSIFIED_HEADERS.includes(name)));
    const classified = await classify({ tabId, pageUrl: cap.pageUrl, url, headers, bodyBytes: null, manifestText: null });
    if (state.controller.signal.aborted) return;
    // A media element asked for it: that it is a media file is the browser's own reading, whatever the server calls it.
    const file = shouldSurfaceDescriptor(classified) ? classified
      : origin?.via.includes("network-media") && classified.source.kind === "direct-url"
        ? { ...classified, protocol: "progressive-http" as const, capabilities: { directDownload: true, remuxableTo: [] } } : null;
    if (!file) return;
    const final = options.observedUrl && options.observedUrl !== url && file.source.kind === "direct-url" ? options.observedUrl : null;
    deps.onDescriptor(tabId, { ...file, detectedAt: Date.now(), unchecked: true,
      ...(final && file.source.kind === "direct-url" ? { source: { ...file.source, finalUrl: final } } : {}) }, origin);
  }
  function forget(tabId: number, urls: readonly string[]): void {
    const known = tabs.get(tabId)?.known;
    for (const url of urls) known?.delete(playlistIdentity(url));
  }
  function handleCapture(tabId: number, msg: CaptureMessage, options: CaptureOptions = {}): Promise<void> {
    const cap = msg.payload;
    const url = cap.kind === "media-source" && cap.url ? normalizeMediaUrl(cap.url) : null;
    if (!url) return Promise.resolve();
    // The length a page's own messages may name is the length of any address that is checked.
    if (url.length > MAX_ADDRESS_LENGTH || (options.observedUrl?.length ?? 0) > MAX_ADDRESS_LENGTH) return Promise.resolve();
    const ad = !!deps.isAd?.(tabId, url) || (!!options.observedUrl && !!deps.isAd?.(tabId, options.observedUrl));
    let state = tabs.get(tabId);
    if (!state) {
      state = { controller: new AbortController(), pending: new Map(), known: new Map(), running: 0, frames: new Map(), waiting: [],
        asked: 0, askedWaiting: [] };
      tabs.set(tabId, state);
    }
    const origin: Origin | null = options.origin
      ? { ...options.origin, generation: deps.generation?.(tabId, options.origin.frameId) ?? 0, referrer: originOfPage(options.referrerPage ?? cap.pageUrl) } : null;
    const identity = playlistIdentity(url);
    // An address named as an ad is never requested on savemedia's own. What the browser itself received of it is listed, once.
    if (ad && !options.adRequested) return listObserved(tabId, state, cap, url, origin, options);
    // A row listed from the browser's answer was never checked: the user's Save checks it now.
    const noted = state.known.get(identity);
    const known = noted?.kind === "observed" ? undefined : noted;
    const addsDetail = known?.kind === "descriptor"
      && ((!!cap.filenameHint && !known.named) || (!!cap.quality && known.group !== cap.quality.groupId));
    if (known && !addsDetail && (known.kind === "descriptor" || (known.generation === (origin?.generation ?? 0) && !options.retryFailed))) {
      if (origin) deps.onSeen?.(tabId, url, origin);
      return Promise.resolve();
    }
    const key = JSON.stringify([url, cap.audioUrl, cap.quality, cap.filenameHint, options.observedUrl, options.referrerPage, options.credentials]);
    const existing = state.pending.get(key);
    if (existing) return existing.promise;
    const current = state;
    const controller = new AbortController();
    const abort = () => controller.abort();
    current.controller.signal.addEventListener("abort", abort, { once: true });
    const lane: Lane = options.priority === true ? { asked: true } : { asked: false, frameId: options.origin?.frameId ?? 0 };
    const started = limited(current, lane, () => controller.signal.aborted ? Promise.resolve("none" as const)
      : capture(tabId, { ...msg, payload: { ...cap, url } }, controller.signal, origin, options));
    if (!started) {
      current.controller.signal.removeEventListener("abort", abort);
      return Promise.resolve();
    }
    const promise = started.then(outcome => {
      if (controller.signal.aborted || outcome === "none") return;
      remember(current, identity, outcome === "descriptor"
        ? { kind: "descriptor", named: !!cap.filenameHint || (known?.kind === "descriptor" && known.named), group: cap.quality?.groupId ?? (known?.kind === "descriptor" ? known.group : null) }
        : { kind: "failure", generation: origin?.generation ?? 0 });
    }).finally(() => {
      current.pending.delete(key);
      current.controller.signal.removeEventListener("abort", abort);
    });
    current.pending.set(key, { promise, controller, urls: [identity, ...(options.observedUrl ? [playlistIdentity(options.observedUrl)] : [])],
      listObserved: options.observedHeaders && !options.adRequested ? () => { void listObserved(tabId, current, cap, url, origin, options); } : null });
    return promise;
  }

  /** One check. The Referer rules it asked for are its own until it ends. */
  async function capture(tabId: number, msg: CaptureMessage, signal: AbortSignal, origin: Origin | null, options: CaptureOptions): Promise<"descriptor" | "failure" | "none"> {
    const holder = `probe:${tabId}:${++probes}`;
    try { return await check(tabId, msg, signal, origin, options, holder); }
    finally { deps.releaseReferer?.(holder); }
  }

  async function check(tabId: number, msg: CaptureMessage, signal: AbortSignal, origin: Origin | null, options: CaptureOptions,
    holder: string): Promise<"descriptor" | "failure" | "none"> {
    const cap = msg.payload;
    const url = cap.url!;
    const { observedUrl, referrerPage } = options;
    if (cap.audioUrl && !/^https?:\/\//i.test(cap.audioUrl)) return "none";
    /**
     * The source is not listed, and the reason is. What a script fetched is different: the page got its
     * answer, and nothing says it is a video the page then failed to load. Whatever its check ends with,
     * nothing is listed and nothing is explained. An ending that may not repeat (a lost connection, or a
     * status the retry policy calls transient, such as 503 or 429) keeps the address for the next look;
     * any other ending (a refusal, a missing file, an answer that is no video) lets it go like a part of
     * a stream, so it is not requested again.
     */
    const failed = (error: JobError): "failure" | "none" => {
      if (options.wholeFile) {
        const temporary = error.code === "network_unreachable"
          || ("httpStatus" in error && typeof error.httpStatus === "number" && isRetryableStatus("manifest", error.httpStatus));
        if (!temporary) deps.onPart?.(tabId, url);
        return "none";
      }
      deps.onFailure?.(tabId, { url, error }, origin);
      return "failure";
    };
    // For a public page, a server inside the user's network is requested only when the browser itself
    // received an answer from that origin there, in this tab. One the page only names is never requested.
    const page = referrerPage ?? cap.pageUrl;
    const observed = (target: string): boolean => deps.observedLocal?.(tabId, target) ?? false;
    // The browser itself reached the tab's own page, or the frame that asks, under a public name at an address
    // inside the user's network: the page lives there, or the browser reaches the internet through a proxy
    // there. The server address the browser reports then says nothing about where a public name leads, for
    // any request of this tab. Only an address that is itself local is still held back until the browser was there.
    const addressesSayNothing = reachedLocallyByName(cap.pageUrl, observed) || reachedLocallyByName(page, observed);
    const unobserved = (target: string, ip?: string | null): boolean => unobservedLocalTarget(page, target, observed, addressesSayNothing ? null : ip);
    if ([url, observedUrl, cap.audioUrl].some(target => target && unobserved(target, target === url || target === observedUrl ? options.serverIp : null))) {
      // Nothing is requested, and the user is told why this source is not listed.
      if (unobserved(url, options.serverIp)) return failed(insideNetwork(url, options.serverIp ?? null));
      return "none";
    }

    const detectedAt = Date.now();
    let headers: Record<string, string> = {};
    let bodyBytes: Uint8Array | null = null;
    let manifestText: string | null = null;
    let finalUrl = url;
    // The words of a failure only: what is saved is decided by the bytes below.
    let probePhase: "direct" | "manifest" = urlKind(url) === "manifest" ? "manifest" : "direct";
    let directContainer: ReturnType<typeof requireDirectVideo> | null = null;
    // Encryption declared in the probed boxes or tracks, before the first sample.
    let mp4Protection: DrmStatus = null;
    const credentials = options.credentials ?? "include";
    // A public name can resolve to a server inside the user's network. That is known only from the address
    // the browser reports for savemedia's own request, after it left. Where the browser itself was answered
    // from that origin there, the answer is what the browser received and is used. Otherwise it is dropped unused.
    const answered: object[] = [];
    /** The local server address of a step of the check's own requests that the browser was not at for this page. */
    const privateServerAddress = (): string | null => answered.flatMap(response => deps.serverHops?.(response) ?? [])
      .find(hop => unobserved(hop.url, hop.ip))?.ip ?? null;
    const reachedPrivateServer = (): boolean => privateServerAddress() !== null;
    /** The answer came from inside the user's network, from a server the browser was not at for this page: nothing of it is used. */
    const droppedAsInside = (finalAddress: string): "failure" | "none" | null => {
      if (!unobserved(finalAddress) && !reachedPrivateServer()) return null;
      return signal.aborted ? "none" : failed(insideNetwork(url, privateServerAddress() ?? literalAddress(finalAddress)));
    };
    const baseFetch: CaptureDeps["fetchFn"] = async (target, init) => {
      const response = await deps.fetchFn(target, credentials === "include" ? init : { ...init, credentials: "omit" } as unknown as ProbeInit);
      answered.push(response);
      return response;
    };
    const report = deps.onHttp ? (event: HttpObservation) => {
      if (!signal.aborted) deps.onHttp?.(tabId, event);
    } : undefined;
    const fetchFile = report ? observeFetch(baseFetch, report) : baseFetch;

    try {
      if (deps.mirrorReferer) {
        await deps.mirrorReferer(url, page, holder);
        if (observedUrl && observedUrl !== url) await deps.mirrorReferer(observedUrl, page, holder);
        if (signal.aborted) return "none";
      }
      // The first request is always a bounded one. The bytes it returns, or the
      // type the server states, say whether this is a playlist or a file.
      const probe = await boundedProbe(fetchFile, url, signal);
      const inside = droppedAsInside(probe.url);
      if (inside) return inside;
      finalUrl = probe.url;
      headers = probe.headers;
      bodyBytes = probe.bytes;
      const prefix = new TextDecoder().decode(probe.bytes).trimStart();
      const playlist = playlistMime(prefix);
      if (playlist === null && mimeKind(headers["content-type"]) !== "manifest") {
        probePhase = "direct";
        directContainer = requireDirectVideo(probe.bytes, headers);
        if (options.wholeFile && !beginsWholeMediaFile(probe.bytes, directContainer, declaredTotalBytes(headers))) {
          deps.onPart?.(tabId, url);
          return "none";
        }
        headers["content-type"] = DIRECT_MEDIA_TYPES[directContainer];
        const found = directContainer === "mp4" || directContainer === "mov" ? findMp4Protection(probe.bytes) : null;
        if (found) mp4Protection = { reason: "cdm_required", detectedVia: ["mp4-protection"], keySystem: found.keySystem ?? found.scheme };
        if ((directContainer === "webm" || directContainer === "mkv") && hasMatroskaEncryption(probe.bytes)) {
          mp4Protection = { reason: "cdm_required", detectedVia: ["matroska-protection"], keySystem: null };
        }
      } else {
        probePhase = "manifest";
        // A prefix cannot parse a full playlist: read it whole, up to the limit.
        const hls = prefix.startsWith("#EXTM3U");
        const whole = await recoverRequest(async (attemptSignal, receivedBytes) => {
          const r = await fetchFile(url, { credentials: "include", cache: hls ? "default" : "no-store", signal: attemptSignal });
          try {
            checkResponseStatus(r, url);
            const h = responseHeaders(r);
            // Progress counts as progress only at a rate a real playlist arrives at.
            let since = 0;
            const arrived = (bytes: number): void => {
              since += bytes;
              if (since >= MANIFEST_WINDOW_BYTES) { since = 0; receivedBytes(); }
            };
            return { headers: h, text: await readManifestText(r, url, arrived), url: r.url || url };
          } finally {
            try { await r.body?.cancel(); } catch { /* already consumed */ }
          }
        }, signal);
        const wholeInside = droppedAsInside(whole.url);
        if (wholeInside) return wholeInside;
        finalUrl = whole.url;
        // The request may succeed with a login, warning or error document.
        const mime = playlistMime(whole.text.trimStart());
        if (!mime) requireDirectVideo(new TextEncoder().encode(whole.text.slice(0, 4096)), whole.headers);
        headers = { ...whole.headers, "content-type": mime ?? whole.headers["content-type"] ?? "" };
        manifestText = whole.text;
        bodyBytes = null;
      }
    } catch (err) {
      if (signal.aborted) return "none";
      deps.logger?.debug("capture fetch failed", { err: err instanceof Error ? err.name : "probe failed" });
      const failure = ownFailure(err) ?? rangeFailure(err, url, probePhase);
      // What a script fetched is let go, whatever the check ended with: nothing is explained, because nothing is told.
      if (options.wholeFile) return failed(failure);
      const explained = deps.explain ? await deps.explain(failure, answered.at(-1) ?? null, url, signal, addressesSayNothing) : failure;
      if (signal.aborted) return "none";
      return failed(explained);
    }
    if (signal.aborted) return "none";
    deps.onProbeSuccess?.(tabId, url);

    let classified: StreamDescriptor;
    try {
      classified = await classify({
        tabId,
        pageUrl: cap.pageUrl,
        url,
        headers: Object.fromEntries(Object.entries(headers).filter(([key]) => CLASSIFIED_HEADERS.includes(key))),
        bodyBytes,
        manifestText,
        ...(manifestText && finalUrl ? { manifestBaseUrl: finalUrl } : {}),
        ...(directContainer ? { fileContainer: directContainer } : {}),
      });
    } catch (err) {
      // A manifest that declares more than is read is refused before it is expanded.
      const error = ownFailure(err);
      if (!error) throw err;
      return failed(error);
    }
    let directOrStream: StreamDescriptor = { ...classified, detectedAt };
    if (mp4Protection) {
      directOrStream = { ...directOrStream, drm: mp4Protection, capabilities: { directDownload: false, remuxableTo: [] } };
    }
    if (directContainer && classified.source.kind === "direct-url" && finalUrl) {
      directOrStream = {
        ...directOrStream,
        title: originalMediaFilename(classified.title, directContainer)
          ?? originalMediaFilename(cap.filenameHint ?? null, directContainer, finalUrl, url),
        source: { ...classified.source, ...(finalUrl !== url ? { finalUrl } : {}) },
      };
    }
    if (manifestText && classified.protocol === "hls") {
      const { assetUris, assetLists } = hlsInterstitials(manifestText, finalUrl);
      if (assetUris.length || assetLists.length) deps.onAds?.(tabId, assetUris, "hls-interstitial", assetLists, origin?.frameId ?? 0);
    }
    if (classified.presentation) deps.onTimeline?.(tabId, url, classified.presentation);

    // A capture carrying a companion audio URL is a demuxed pair; reshape it
    // for the av-merge path once the video half is confirmed downloadable.
    // An unconfirmed half (expired signature, fetch failure) falls through
    // as-is and is dropped by the surfacing gate below.
    let descriptor = cap.audioUrl !== undefined && directOrStream.capabilities.directDownload
      ? demuxedPairDescriptor(
        directOrStream,
        cap.audioUrl,
        declaredTotalBytes(headers),
        await probeDeclaredBytes(baseFetch, cap.audioUrl, signal),
      )
      : directOrStream;

    // Attach page-declared quality only after the URL passed the media probe.
    // Each alternative retains its own descriptor, headers and download URL.
    if (cap.quality && cap.audioUrl === undefined && descriptor.capabilities.directDownload && descriptor.source.kind === "direct-url") {
      descriptor = { ...descriptor, mediaGroup: cap.quality.groupId, variants: [{
        id: descriptor.source.url as VariantId,
        width: null, height: cap.quality.height ?? null, frameRate: null, bitrate: null,
        estimatedSize: declaredTotalBytes(headers), videoCodec: null, audioCodec: null,
        audioRenditionId: null, segmentRef: { kind: "direct", url: descriptor.source.url },
      }] };
    }

    if (signal.aborted) return "none";
    if (reachedPrivateServer()) return failed(insideNetwork(url, privateServerAddress()));
    if (!shouldSurfaceDescriptor(descriptor)) return "none";
    // A row is listed with a sample of its segment list. One that is still too large is not listed at all.
    if (rowBytes(thinDescriptor(descriptor)) > MAX_ROW_BYTES) {
      if (!manifestText) return "none";
      return failed(manifestTooLarge(url, "bytes"));
    }
    deps.onDescriptor(tabId, descriptor, origin);
    return "descriptor";
  }
  /**
   * A page on the public internet points at a server inside the user's network that the browser itself was
   * not answered from for this tab: by the address itself (`ip` null, nothing was requested) or because a
   * public name led there (`ip`, the address the browser reported; the answer is not used). The source is
   * not listed, and the reason is.
   */
  function insideNetwork(url: string, ip: string | null): JobError {
    return { code: "private_network_target", severity: "terminal", host: hostOfAddress(url), ...(ip ? { ip } : {}) };
  }
  return Object.assign(handleCapture, { clearTab, abortUrl, forget });
}

function hostOfAddress(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

/** The host of an address when it is an IP address written out, else null. */
function literalAddress(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    return addressScope(hostname) !== null ? hostname.replace(/^\[|\]$/g, "") : null;
  } catch { return null; }
}

function originOfPage(page: string): string | null {
  try {
    const { protocol, origin } = new URL(page);
    return protocol === "https:" || protocol === "http:" ? origin : null;
  } catch { return null; }
}

/** Failures this module states itself, as opposed to transfer failures. */
function ownFailure(error: unknown): JobError | null {
  return isJobError(error) && (error.code === "unexpected_media_response" || error.code === "manifest_too_large") ? error : null;
}

/**
 * The first 4096 bytes. A server that answers a range of a compressed
 * response cannot be checked by range arithmetic, so that one case reads the
 * start of the whole response instead.
 */
async function boundedProbe(fetchFn: ProbeFetch, url: string, signal: AbortSignal): Promise<MediaProbe> {
  try { return await probeMedia(fetchFn, url, signal); }
  catch (error) {
    if (!isTransferError(error, "range-encoded")) throw error;
    return recoverRequest(async attemptSignal => {
      const response = await fetchFn(url, { credentials: "include", cache: "no-store", signal: attemptSignal });
      try {
        checkResponseStatus(response, url);
        const headers = responseHeaders(response);
        delete headers["content-range"];
        return { url: response.url || url, headers, bytes: await readBytes(response, url, 4096, false) };
      } finally {
        try { await response.body?.cancel(); } catch { /* Already consumed or interrupted. */ }
      }
    }, signal);
  }
}

function playlistMime(text: string): string | null {
  if (text.startsWith("#EXTM3U")) return "application/vnd.apple.mpegurl";
  if (/^(?:<\?xml[^>]*>\s*)?<MPD(?:\s|>)/.test(text)) return "application/dash+xml";
  return null;
}

export function shouldSurfaceDescriptor(descriptor: StreamDescriptor): boolean {
  if (descriptor.drm) return true;
  if (descriptor.capabilities.directDownload) return true;
  return descriptor.protocol === "hls" || descriptor.protocol === "dash";
}

/**
 * Range-probe a companion track for its declared byte total so the browser
 * output-size guard counts both halves of a demuxed pair. Any failure yields
 * null — the size stays unknown rather than wrong.
 */
async function probeDeclaredBytes(fetchFn: CaptureDeps["fetchFn"], url: string, signal: AbortSignal): Promise<number | null> {
  try {
    const r = await fetchFn(url, {
      credentials: "include",
      signal,
      headers: { range: "bytes=0-0" },
    });
    try { await r.body?.cancel(); } catch { /* stream already closed */ }
    checkResponseStatus(r, url);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return declaredTotalBytes(headers);
  } catch {
    return null;
  }
}

/**
 * Reshape a confirmed progressive video descriptor plus its companion audio
 * URL into the demuxed form dispatch understands: protocol "dash" with one
 * video variant and one linked audio rendition, each a single-URL
 * `dash-segments` ref (the documented progressive `MergeTrack` case — no
 * init segment, one media URL). Core dispatch's DASH branch turns exactly
 * this shape into an `AvMergePlan`; `directDownload` is cleared so the
 * video-only half can never ship alone as a silent "direct" download. The
 * `direct-url` source is kept so router de-duplication keys stay per-video.
 *
 * `videoSizeBytes` / `audioSizeBytes` (each probe's declared total) ride the
 * halves as `estimatedSize`, without a bit rate: sizes their servers stated,
 * so dispatch's browser-output size guard counts the whole merged output
 * before the save starts. An unprobeable half stays null rather than wrong.
 */
export function demuxedPairDescriptor(
  descriptor: StreamDescriptor,
  audioUrl: string,
  videoSizeBytes: number | null,
  audioSizeBytes: number | null,
): StreamDescriptor {
  if (descriptor.source.kind !== "direct-url") return descriptor;
  const videoUrl = descriptor.source.url;
  const renditionId = `${audioUrl}#audio` as AudioRenditionId;
  const video: Variant = {
    id: `${videoUrl}#video` as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: null,
    estimatedSize: videoSizeBytes,
    videoCodec: null,
    audioCodec: null,
    audioRenditionId: renditionId,
    segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [videoUrl] },
  };
  const audio: Variant = {
    id: `${audioUrl}#audio` as VariantId,
    width: null,
    height: null,
    frameRate: null,
    bitrate: null,
    estimatedSize: audioSizeBytes,
    videoCodec: null,
    audioCodec: null,
    audioRenditionId: renditionId,
    segmentRef: { kind: "dash-segments", initUrl: "", mediaUrls: [audioUrl] },
  };
  return {
    ...descriptor,
    protocol: "dash",
    variants: [video],
    audioRenditions: [audio],
    capabilities: {
      directDownload: false,
      remuxableTo: [],
    },
  };
}
