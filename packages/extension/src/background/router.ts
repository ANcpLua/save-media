import {
  dispatch,
  type StreamDescriptor,
  type UserChoice,
  type JobError,
  type JobPlan,
  type DispatchRefusal,
  type Variant,
} from "@savemedia/core";
import type {
  PopupToBackgroundMessage,
  BackgroundToPopupMessage,
  BackgroundToEngineMessage,
  EngineToBackgroundMessage,
  DiscoveryFailure,
  JobStatus,
} from "../types/messages";
import type { Logger } from "../util/logger";
import { REFRESHING_VIDEO_SOURCE } from "../types/messages";
import { suggestFilename, timestampedPath } from "../util/filename";
import { dispatchRefusalToError } from "../util/dispatch-refusal";
import { isDownloadableCandidate } from "../util/downloadable";

export { dispatchRefusalToError } from "../util/dispatch-refusal";

type HlsDescriptor = StreamDescriptor & {
  readonly source: { readonly kind: "hls-manifest"; readonly manifestUrl: string; readonly type: "master" | "media" };
};

function saveFailure(err: unknown, filename: string): JobError {
  if (err instanceof Error && err.message === "USER_CANCELED") {
    return { code: "user_cancelled", severity: "terminal", bytesDiscarded: 0 };
  }
  return { code: "browser_download_failed", severity: "terminal", reason: err instanceof Error ? err.message : String(err), filename };
}

export interface TabState {
  readonly descriptors: Map<string, StreamDescriptor>;
  readonly hlsCoveredDirectUrls: Set<string>;
  readonly failures: Map<string, DiscoveryFailure>;
  discoveryScope: { readonly pageUrl: string; readonly urls: ReadonlySet<string> } | null;
}

export interface RouterDeps {
  readonly runtime: {
    sendMessage: (msg: unknown, cb?: (resp: unknown) => void) => void;
  };
  readonly downloads: {
    download: (opts: { url: string; filename: string; conflictAction?: string }) => Promise<number>;
  };
  readonly ensureEngineHost: () => Promise<void>;
  readonly refreshDirectSource?: (descriptor: StreamDescriptor, signal: AbortSignal) => Promise<StreamDescriptor | null>;
  readonly releaseBlob?: (url: string) => void;
  readonly logger?: Logger;
}

interface ActiveJob {
  readonly descriptor: StreamDescriptor;
  readonly choice: UserChoice;
  readonly plan: JobPlan | null;
  refresh?: AbortController;
}

export type BestDownloadOutcome =
  | { readonly kind: "started"; readonly streamId: StreamDescriptor["id"] }
  | { readonly kind: "no-media" }
  | { readonly kind: "failed"; readonly streamId: StreamDescriptor["id"]; readonly error: JobError; readonly duringDiscovery?: true };

export interface NamedFile {
  readonly pageUrl: string;
  readonly filename: string;
}

export interface Router {
  readonly tabs: Map<number, TabState>;
  readonly jobs: Map<StreamDescriptor["id"], ActiveJob>;
  readonly addDescriptor: (tabId: number, descriptor: StreamDescriptor) => boolean;
  readonly listDescriptors: (tabId: number) => readonly StreamDescriptor[];
  readonly setDiscoveryScope: (tabId: number, pageUrl: string, urls: readonly string[]) => void;
  readonly setDiscoveryFailure: (tabId: number, failure: DiscoveryFailure) => void;
  readonly clearDiscoveryFailure: (tabId: number, url: string) => boolean;
  readonly snapshot: (tabId: number) => Extract<BackgroundToPopupMessage, { type: "descriptors" }>;
  readonly findDescriptor: (id: StreamDescriptor["id"]) => StreamDescriptor | null;
  readonly clearTab: (tabId: number) => void;
  readonly startDownload: (id: StreamDescriptor["id"], choice: UserChoice) => Promise<JobError | null>;
  readonly startBestDownload: (tabId: number, file?: NamedFile) => Promise<BestDownloadOutcome>;
  readonly handleEngineMessage: (msg: EngineToBackgroundMessage) => Promise<BackgroundToPopupMessage | null>;
  readonly handlePopupMessage: (
    msg: PopupToBackgroundMessage,
  ) => Promise<BackgroundToPopupMessage | { ok: true } | null>;
}

export function createRouter(deps: RouterDeps): Router {
  const tabs = new Map<number, TabState>();
  const jobs = new Map<StreamDescriptor["id"], ActiveJob>();
  const statuses = new Map<string, JobStatus>();

  function getTab(tabId: number): TabState {
    let s = tabs.get(tabId);
    if (!s) {
      s = { descriptors: new Map(), hlsCoveredDirectUrls: new Set(), failures: new Map(), discoveryScope: null };
      tabs.set(tabId, s);
    }
    return s;
  }

  function descriptorKey(d: StreamDescriptor): string {
    const src = d.source.kind === "direct-url"
      ? d.source.url
      : d.source.kind === "hls-manifest" || d.source.kind === "dash-manifest"
        ? d.source.manifestUrl
        : d.source.elementSrc;
    return `${d.source.kind}:${d.protocol}:${d.drm?.reason ?? ""}:${normalizedUrl(src)}`;
  }

  function normalizedUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return url;
    }
  }

  function directAliases(d: StreamDescriptor): readonly string[] {
    if (d.source.kind !== "direct-url" || !d.capabilities.directDownload) return [];
    return [d.source.url, ...(d.source.finalUrl ? [d.source.finalUrl] : [])].map(normalizedUrl);
  }

  function directUrl(d: StreamDescriptor): string | null {
    return d.source.kind === "direct-url" ? normalizedUrl(d.source.url) : null;
  }

  function hlsCoveredDirectUrls(d: StreamDescriptor): readonly string[] {
    if (d.protocol !== "hls") return [];
    const urls: string[] = [];
    for (const v of d.variants) {
      if (v.segmentRef.kind !== "hls-segments") continue;
      if (v.segmentRef.initSegmentUrl) urls.push(normalizedUrl(v.segmentRef.initSegmentUrl));
      for (const url of v.segmentRef.segmentUrls) urls.push(normalizedUrl(url));
    }
    return urls;
  }

  function indexHlsCoveredDirectUrls(state: TabState, d: StreamDescriptor): void {
    for (const url of hlsCoveredDirectUrls(d)) state.hlsCoveredDirectUrls.add(url);
  }

  function removeHlsCoveredDirectDescriptors(state: TabState): number {
    if (state.hlsCoveredDirectUrls.size === 0) return 0;
    let removed = 0;
    for (const [key, existing] of state.descriptors.entries()) {
      const url = directUrl(existing);
      if (url && state.hlsCoveredDirectUrls.has(url)) {
        state.descriptors.delete(key);
        removed++;
      }
    }
    return removed;
  }

  function isHlsCoveredDirectDescriptor(state: TabState, d: StreamDescriptor): boolean {
    const url = directUrl(d);
    return url !== null && state.hlsCoveredDirectUrls.has(url);
  }

  function hlsVariantPlaylistUrls(d: StreamDescriptor): Set<string> {
    const urls = new Set<string>();
    if (d.protocol !== "hls") return urls;
    for (const v of d.variants) {
      if (v.segmentRef.kind === "hls-segments") urls.add(v.segmentRef.playlistUrl);
    }
    return urls;
  }

  function isHlsMediaPlaylist(d: StreamDescriptor): d is HlsDescriptor & { readonly source: HlsDescriptor["source"] & { readonly type: "media" } } {
    return d.source.kind === "hls-manifest" && d.source.type === "media";
  }

  function isHlsMasterPlaylist(d: StreamDescriptor): d is HlsDescriptor & { readonly source: HlsDescriptor["source"] & { readonly type: "master" } } {
    return d.source.kind === "hls-manifest" && d.source.type === "master";
  }

  function removeCoveredHlsMediaDescriptors(state: TabState, master: StreamDescriptor): void {
    const covered = hlsVariantPlaylistUrls(master);
    if (covered.size === 0) return;
    for (const [k, existing] of state.descriptors.entries()) {
      if (isHlsMediaPlaylist(existing) && covered.has(existing.source.manifestUrl)) {
        state.descriptors.delete(k);
      }
    }
  }

  function hlsMediaCoveredByExistingMaster(state: TabState, media: StreamDescriptor): boolean {
    if (!isHlsMediaPlaylist(media)) return false;
    for (const existing of state.descriptors.values()) {
      if (isHlsMasterPlaylist(existing) && hlsVariantPlaylistUrls(existing).has(media.source.manifestUrl)) {
        return true;
      }
    }
    return false;
  }

  function addDescriptor(tabId: number, descriptor: StreamDescriptor): boolean {
    const state = getTab(tabId);
    let removedCoveredDirects = 0;
    if (descriptor.protocol === "hls") {
      indexHlsCoveredDirectUrls(state, descriptor);
      removedCoveredDirects = removeHlsCoveredDirectDescriptors(state);
    }

    if (hlsMediaCoveredByExistingMaster(state, descriptor)) return removedCoveredDirects > 0;
    if (isHlsMasterPlaylist(descriptor)) removeCoveredHlsMediaDescriptors(state, descriptor);
    if (isHlsCoveredDirectDescriptor(state, descriptor)) return false;

    const key = descriptorKey(descriptor);
    const aliases = directAliases(descriptor);
    const matches = aliases.length > 0
      ? [...state.descriptors.values()].filter(d => directAliases(d).some(url => aliases.includes(url))) : [];
    const existing = state.descriptors.get(key) ?? matches[0];
    if (!existing) {
      state.descriptors.set(key, descriptor);
      return true;
    }

    const oldKey = descriptorKey(existing);
    const oldFinal = existing.source.kind === "direct-url" ? existing.source.finalUrl : undefined;
    const newFinal = descriptor.source.kind === "direct-url" ? descriptor.source.finalUrl : undefined;
    // Keep a known redirect entry over its transient destination. Refresh
    // the destination for the same entry and upgrade passive captures with
    // page-declared quality without losing the row ID or job status.
    if (oldKey !== key && oldFinal && !newFinal) return false;
    const upgradedQuality = descriptor.mediaGroup && (existing.mediaGroup !== descriptor.mediaGroup
      || existing.variants[0]?.height !== descriptor.variants[0]?.height);
    const refreshedRedirect = newFinal && oldFinal !== newFinal && descriptor.detectedAt >= existing.detectedAt;
    const gainedFilename = descriptor.title && !existing.title;
    if (!upgradedQuality && !refreshedRedirect && !gainedFilename && !(oldKey !== key && !oldFinal && newFinal)) return false;
    for (const match of matches) state.descriptors.delete(descriptorKey(match));
    state.descriptors.delete(oldKey);
    state.descriptors.set(key, { ...descriptor, id: existing.id, title: descriptor.title ?? existing.title, ...(!descriptor.mediaGroup && existing.mediaGroup
      ? { mediaGroup: existing.mediaGroup, variants: existing.variants } : {}) });
    return true;
  }

  function setDiscoveryScope(tabId: number, pageUrl: string, urls: readonly string[]): void {
    const state = getTab(tabId);
    state.discoveryScope = urls.length ? { pageUrl, urls: new Set(urls.map(normalizedUrl)) } : null;
  }

  function inDiscoveryScope(state: TabState, descriptor: StreamDescriptor): boolean {
    const scope = state.discoveryScope;
    // Keep protection signals visible even when they have no matching source URL.
    if (!scope || descriptor.drm) return true;
    if (descriptor.pageUrl !== scope.pageUrl) return false;
    const source = descriptor.source;
    const url = source.kind === "direct-url" ? source.url
      : source.kind === "media-element" ? source.elementSrc : source.manifestUrl;
    if (scope.urls.has(normalizedUrl(url)) || directAliases(descriptor).some(alias => scope.urls.has(alias))) return true;
    return isHlsMasterPlaylist(descriptor) && [...hlsVariantPlaylistUrls(descriptor)]
      .some(variantUrl => scope.urls.has(normalizedUrl(variantUrl)));
  }

  function listDescriptors(tabId: number): readonly StreamDescriptor[] {
    const state = tabs.get(tabId);
    if (!state) return [];
    return [...state.descriptors.values()].filter(d => inDiscoveryScope(state, d));
  }

  function findDescriptor(id: StreamDescriptor["id"]): StreamDescriptor | null {
    for (const state of tabs.values()) {
      for (const d of state.descriptors.values()) if (d.id === id) return d;
    }
    return null;
  }

  function clearTab(tabId: number): void {
    const ids = [...(tabs.get(tabId)?.descriptors.values() ?? [])].map(d => d.id);
    tabs.delete(tabId);
    for (const id of ids) if (!jobs.has(id) && !findDescriptor(id)) statuses.delete(id);
  }

  function setDiscoveryFailure(tabId: number, failure: DiscoveryFailure): void {
    const state = getTab(tabId);
    state.failures.set(failure.url, failure);
    // Bound failed network candidates, including pages with many broken fragments.
    if (state.failures.size > 20) state.failures.delete(state.failures.keys().next().value!);
  }

  function clearDiscoveryFailure(tabId: number, url: string): boolean {
    return tabs.get(tabId)?.failures.delete(url) ?? false;
  }

  function listDiscoveryFailures(tabId: number): readonly DiscoveryFailure[] {
    const state = tabs.get(tabId);
    if (!state) return [];
    return [...state.failures.values()].filter(failure =>
      !state.discoveryScope || state.discoveryScope.urls.has(normalizedUrl(failure.url)));
  }

  function snapshot(tabId: number): Extract<BackgroundToPopupMessage, { type: "descriptors" }> {
    const descriptors = listDescriptors(tabId);
    return { type: "descriptors", tabId, descriptors,
      failures: listDiscoveryFailures(tabId),
      statuses: Object.fromEntries(descriptors.flatMap(d => {
        const status = statuses.get(d.id);
        return status ? [[d.id, status]] : [];
      })),
    };
  }

  function bestVariant(d: StreamDescriptor): Variant | null {
    if (d.variants.length === 0) return null;
    const sorted = [...d.variants].sort((a, b) => {
      const h = (b.height ?? 0) - (a.height ?? 0);
      if (h !== 0) return h;
      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });
    return sorted[0] ?? null;
  }

  function bestDescriptorScore(d: StreamDescriptor): [number, number, number, number] {
    const variant = bestVariant(d);
    const protocolRank = d.protocol === "hls"
      ? 3
      : d.protocol === "progressive-http"
        ? 2
        : 1;
    return [
      variant?.height ?? 0,
      variant?.bitrate ?? 0,
      protocolRank,
      d.detectedAt,
    ];
  }

  function compareBestDescriptors(a: StreamDescriptor, b: StreamDescriptor): number {
    const as = bestDescriptorScore(a);
    const bs = bestDescriptorScore(b);
    for (let i = 0; i < as.length; i++) {
      const diff = (bs[i] ?? 0) - (as[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return a.id.localeCompare(b.id);
  }

  function bestDownloadChoice(d: StreamDescriptor): UserChoice {
    const variant = bestVariant(d);
    return {
      outputMode: "Original",
      filename: suggestFilename(d),
      variantId: variant?.id ?? null,
      audioRenditionId: variant?.audioRenditionId ?? null,
    };
  }

  async function startBestDownload(tabId: number, file?: NamedFile): Promise<BestDownloadOutcome> {
    if (file) {
      for (const [streamId, { descriptor }] of jobs) {
        if (descriptor.tabId === tabId && descriptor.pageUrl === file.pageUrl
          && descriptor.title === file.filename && descriptor.source.kind === "direct-url") {
          return { kind: "started", streamId };
        }
      }
    }
    const descriptors = [...listDescriptors(tabId)];
    const descriptor = descriptors
      .filter(isDownloadableCandidate)
      .sort(compareBestDescriptors)[0];
    if (!descriptor) {
      // Protected media is media. Reporting it as "nothing on this page" was
      // wrong for the user and unsafe for the boundary: no-media is what the
      // local downloader may take over, so a Widevine page got delegated.
      // Refuse with the DRM code instead; no DRM code is delegable.
      const protectedMedia = descriptors.find(d => d.drm);
      if (protectedMedia?.drm) {
        return {
          kind: "failed",
          streamId: protectedMedia.id,
          error: dispatchRefusalToError(protectedMedia.drm.reason, protectedMedia),
        };
      }
      // Media the engine cannot finish is media too: an audio-less DASH page
      // said "Nothing to save". Name the refusal. It keeps its own
      // delegability, so dash_unsupported still reaches the local downloader
      // when that is on, which is the documented DASH fallback.
      for (const candidate of descriptors) {
        const plan = dispatch(candidate, bestDownloadChoice(candidate));
        if (plan.kind === "refuse") {
          return {
            kind: "failed",
            streamId: candidate.id,
            error: dispatchRefusalToError(plan.reason, candidate),
          };
        }
      }
      const failure = listDiscoveryFailures(tabId)[0];
      if (failure) return { kind: "failed", streamId: `discovery:${tabId}` as StreamDescriptor["id"], error: failure.error, duringDiscovery: true };
      return { kind: "no-media" };
    }

    const error = await startDownload(descriptor.id, bestDownloadChoice(descriptor));
    return error ? { kind: "failed", streamId: descriptor.id, error } : { kind: "started", streamId: descriptor.id };
  }

  /**
   * Demuxed HLS holds only media-playlist URLs until the engine host fetches
   * them (materializeDemuxedHls), so the pre-flight dispatch here sees empty
   * segment lists and would refuse a runnable pair.
   */
  function isUnmaterializedDemuxedHls(d: StreamDescriptor): boolean {
    return d.protocol === "hls"
      && !d.drm
      && d.variants.some(v =>
        v.audioRenditionId !== null
        && v.segmentRef.kind === "hls-segments"
        && v.segmentRef.segmentUrls.length === 0);
  }

  async function startDownload(id: StreamDescriptor["id"], choice: UserChoice): Promise<JobError | null> {
    const descriptor = findDescriptor(id);
    if (!descriptor) {
      return { code: "manifest_404", severity: "terminal", url: "", httpStatus: 0 };
    }
    if (jobs.has(id)) return null;

    const plan: JobPlan | DispatchRefusal = dispatch(descriptor, choice);

    if (plan.kind === "refuse") {
      // Forward an unmaterialized demuxed pair to the engine host, which
      // materializes both media playlists and re-dispatches authoritatively
      // (engine/download.ts); genuine refusals come back as job-failed.
      if (plan.reason !== "no_usable_variant" || !isUnmaterializedDemuxedHls(descriptor)) {
        return dispatchRefusalToError(plan.reason, descriptor);
      }
    }

    jobs.set(id, { descriptor, choice, plan: plan.kind === "refuse" ? null : plan });
    statuses.set(id, { phase: "active", bytesWritten: 0, bytesTotal: null, stage: "Starting" });
    try {
      await deps.ensureEngineHost();
    } catch (err) {
      jobs.delete(id);
      const error: JobError = { code: "engine_job_failed", severity: "terminal", at: "init", detail: err instanceof Error ? err.message : String(err) };
      statuses.set(id, { phase: "failed", error });
      return error;
    }
    const engineMsg: BackgroundToEngineMessage = { type: "start-job", streamId: id, descriptor, choice };
    deps.runtime.sendMessage(engineMsg);
    return null;
  }

  async function handleEngineMessage(msg: EngineToBackgroundMessage): Promise<BackgroundToPopupMessage | null> {
    if (msg.type === "progress") {
      statuses.set(msg.streamId, { phase: "active", bytesWritten: msg.bytesWritten, bytesTotal: msg.bytesTotal, stage: msg.phase });
      return {
        type: "job-progress",
        streamId: msg.streamId,
        bytesWritten: msg.bytesWritten,
        bytesTotal: msg.bytesTotal,
        phase: msg.phase,
      };
    }
    if (msg.type === "complete") {
      const job = jobs.get(msg.streamId);
      const filename = job && job.plan?.kind !== "direct" ? timestampedPath(msg.filename) : msg.filename;
      try {
        await deps.downloads.download({
          url: msg.blobUrl,
          filename,
          conflictAction: "uniquify",
        });
        statuses.set(msg.streamId, { phase: "complete" });
        return { type: "job-complete", streamId: msg.streamId, path: filename };
      } catch (err) {
        const error = saveFailure(err, filename);
        statuses.set(msg.streamId, { phase: "failed", error });
        return {
          type: "job-failed",
          streamId: msg.streamId,
          error,
        };
      } finally {
        jobs.delete(msg.streamId);
        if (msg.blobUrl.startsWith("blob:")) deps.releaseBlob?.(msg.blobUrl);
      }
    }
    if (msg.type === "failed") {
      let { error } = msg;
      const job = jobs.get(msg.streamId);
      if (job?.plan?.kind === "direct" && !job.refresh && deps.refreshDirectSource
        && error.code === "access_denied" && error.phase === "direct" && error.httpStatus === 403) {
        const controller = new AbortController();
        job.refresh = controller;
        const phase = REFRESHING_VIDEO_SOURCE;
        statuses.set(msg.streamId, { phase: "active", bytesWritten: 0, bytesTotal: null, stage: phase });
        const progress: BackgroundToPopupMessage = {
          type: "job-progress", streamId: msg.streamId, bytesWritten: 0, bytesTotal: null, phase,
        };
        deps.runtime.sendMessage(progress);
        const source = await deps.refreshDirectSource(job.descriptor, controller.signal).catch(() => null);
        if (controller.signal.aborted) {
          error = { code: "user_cancelled", severity: "terminal", bytesDiscarded: 0 };
        } else if (source) {
          const descriptor = { ...source, id: msg.streamId, tabId: job.descriptor.tabId };
          const engineMsg: BackgroundToEngineMessage = {
            type: "start-job", streamId: msg.streamId, descriptor, choice: job.choice,
          };
          deps.runtime.sendMessage(engineMsg);
          return null;
        }
      }
      jobs.delete(msg.streamId);
      statuses.set(msg.streamId, { phase: "failed", error });
      return { type: "job-failed", streamId: msg.streamId, error };
    }
    return null;
  }

  async function handlePopupMessage(
    msg: PopupToBackgroundMessage,
  ): Promise<BackgroundToPopupMessage | { ok: true } | null> {
    if (msg.type === "list") {
      return snapshot(msg.tabId);
    }
    if (msg.type === "download") {
      const err = await startDownload(msg.streamId, msg.choice);
      if (err) {
        statuses.set(msg.streamId, { phase: "failed", error: err });
        const failMsg: BackgroundToPopupMessage = { type: "job-failed", streamId: msg.streamId, error: err };
        deps.runtime.sendMessage(failMsg);
      }
      return { ok: true };
    }
    if (msg.type === "cancel") {
      const job = jobs.get(msg.streamId);
      if (job) {
        job.refresh?.abort();
        const engineMsg: BackgroundToEngineMessage = { type: "cancel-job", streamId: msg.streamId };
        deps.runtime.sendMessage(engineMsg);
      }
      return { ok: true };
    }
    return null;
  }

  return {
    tabs,
    jobs,
    addDescriptor,
    listDescriptors,
    setDiscoveryScope,
    setDiscoveryFailure,
    clearDiscoveryFailure,
    snapshot,
    findDescriptor,
    clearTab,
    startDownload,
    startBestDownload,
    handleEngineMessage,
    handlePopupMessage,
  };
}
