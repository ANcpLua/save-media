import {
  dispatch,
  type StreamDescriptor,
  type UserChoice,
  type JobError,
  type JobPlan,
  type DispatchRefusal,
  type OutputContainer,
  type Variant,
} from "@savemedia/core";
import type {
  PopupToBackgroundMessage,
  BackgroundToPopupMessage,
  BackgroundToEngineMessage,
  EngineToBackgroundMessage,
} from "../types/messages";
import type { Logger } from "../util/logger";
import { suggestFilename } from "../util/filename";
import { dispatchRefusalToError } from "../util/dispatch-refusal";

export { dispatchRefusalToError } from "../util/dispatch-refusal";

type HlsDescriptor = StreamDescriptor & {
  readonly source: { readonly kind: "hls-manifest"; readonly manifestUrl: string; readonly type: "master" | "media" };
};

export interface TabState {
  readonly descriptors: Map<string, StreamDescriptor>;
  readonly hlsCoveredDirectUrls: Set<string>;
}

export interface RouterDeps {
  readonly runtime: {
    sendMessage: (msg: unknown, cb?: (resp: unknown) => void) => void;
  };
  readonly downloads: {
    download: (opts: { url: string; filename: string; conflictAction?: string }) => Promise<number>;
  };
  readonly ensureEngineHost: () => Promise<void>;
  readonly logger?: Logger;
}

export interface Router {
  readonly tabs: Map<number, TabState>;
  readonly jobs: Map<StreamDescriptor["id"], { descriptor: StreamDescriptor; choice: UserChoice; plan: JobPlan }>;
  readonly addDescriptor: (tabId: number, descriptor: StreamDescriptor) => boolean;
  readonly listDescriptors: (tabId: number) => readonly StreamDescriptor[];
  readonly findDescriptor: (id: StreamDescriptor["id"]) => StreamDescriptor | null;
  readonly clearTab: (tabId: number) => void;
  readonly startDownload: (id: StreamDescriptor["id"], choice: UserChoice) => Promise<JobError | null>;
  readonly startBestDownload: (tabId: number) => Promise<{ streamId: StreamDescriptor["id"]; error: JobError } | null>;
  readonly handleEngineMessage: (msg: EngineToBackgroundMessage) => Promise<BackgroundToPopupMessage | null>;
  readonly handlePopupMessage: (
    msg: PopupToBackgroundMessage,
  ) => Promise<BackgroundToPopupMessage | { ok: true } | null>;
}

export function createRouter(deps: RouterDeps): Router {
  const tabs = new Map<number, TabState>();
  const jobs = new Map<StreamDescriptor["id"], { descriptor: StreamDescriptor; choice: UserChoice; plan: JobPlan }>();

  function getTab(tabId: number): TabState {
    let s = tabs.get(tabId);
    if (!s) {
      s = { descriptors: new Map(), hlsCoveredDirectUrls: new Set() };
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
    return `${d.source.kind}:${d.protocol}:${src}`;
  }

  /**
   * Tube sites often serve a video as N sequential `.mp4` fragments at
   * URLs that differ only by a numeric component (segment-1.mp4,
   * segment-2.mp4, ...). Without a master playlist we can't stitch them,
   * but we MUST stop surfacing each fragment as a separate "download
   * this video" entry — otherwise the popup fills with junk and the
   * user gets N partial files when they click around.
   *
   * Heuristic: collapse any contiguous run of 2+ digits in the URL to
   * `#` and use that as the segment-family key. The first URL in a
   * family is kept; siblings are suppressed.
   */
  function segmentFamilyKey(d: StreamDescriptor): string | null {
    if (d.source.kind !== "direct-url") return null;
    const url = d.source.url;
    const normalised = url.replace(/\d{2,}/g, "#");
    if (normalised === url) return null; // no numeric component → not segment-shaped
    return `direct-family:${d.protocol}:${normalised}`;
  }

  function normalizedUrl(url: string): string {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
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
    if (state.descriptors.has(key)) return false;
    const family = segmentFamilyKey(descriptor);
    if (family && state.descriptors.has(family)) {
      // A sibling segment from this URL family is already on file; drop.
      return false;
    }
    state.descriptors.set(key, descriptor);
    if (family) state.descriptors.set(family, descriptor);
    return true;
  }

  function listDescriptors(tabId: number): readonly StreamDescriptor[] {
    const all = Array.from(tabs.get(tabId)?.descriptors.values() ?? []);
    // De-dupe identity in case the same descriptor was indexed under both
    // its primary key AND a segment-family key.
    const seen = new Set<string>();
    return all.filter(d => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  }

  function findDescriptor(id: StreamDescriptor["id"]): StreamDescriptor | null {
    for (const state of tabs.values()) {
      for (const d of state.descriptors.values()) if (d.id === id) return d;
    }
    return null;
  }

  function clearTab(tabId: number): void {
    tabs.delete(tabId);
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

  function outputContainerFor(d: StreamDescriptor): OutputContainer {
    if (d.container === "webm") return "webm";
    if (d.container === "mkv") return "mkv";
    return "mp4";
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
      filename: suggestFilename(d, outputContainerFor(d)),
      variantId: variant?.id ?? null,
      audioRenditionId: variant?.audioRenditionId ?? null,
    };
  }

  function isDownloadableCandidate(d: StreamDescriptor): boolean {
    return !d.capabilities.drmBlocked
      && (d.capabilities.directDownload || d.protocol === "hls");
  }

  async function startBestDownload(tabId: number): Promise<{ streamId: StreamDescriptor["id"]; error: JobError } | null> {
    const descriptor = [...listDescriptors(tabId)]
      .filter(isDownloadableCandidate)
      .sort(compareBestDescriptors)[0];
    if (!descriptor) return null;

    const error = await startDownload(descriptor.id, bestDownloadChoice(descriptor));
    return error ? { streamId: descriptor.id, error } : null;
  }

  async function startDownload(id: StreamDescriptor["id"], choice: UserChoice): Promise<JobError | null> {
    const descriptor = findDescriptor(id);
    if (!descriptor) {
      return { code: "manifest_404", severity: "terminal", url: "", httpStatus: 0 };
    }
    if (jobs.has(id)) return null;

    const plan: JobPlan | DispatchRefusal = dispatch(descriptor, choice);

    if (plan.kind === "refuse") {
      return dispatchRefusalToError(plan.reason, descriptor);
    }

    if (plan.kind === "direct") {
      try {
        await deps.downloads.download({
          url: plan.url,
          filename: plan.filename,
          conflictAction: "uniquify",
        });
        return null;
      } catch (err) {
        return {
          code: "browser_download_failed",
          severity: "terminal",
          reason: String((err as Error)?.message ?? err),
          filename: plan.filename,
        };
      }
    }

    jobs.set(id, { descriptor, choice, plan });
    await deps.ensureEngineHost();
    const engineMsg: BackgroundToEngineMessage = { type: "start-job", streamId: id, descriptor, choice };
    deps.runtime.sendMessage(engineMsg);
    return null;
  }

  async function handleEngineMessage(msg: EngineToBackgroundMessage): Promise<BackgroundToPopupMessage | null> {
    if (msg.type === "progress") {
      return {
        type: "job-progress",
        streamId: msg.streamId,
        bytesWritten: msg.bytesWritten,
        bytesTotal: msg.bytesTotal,
        phase: msg.phase,
      };
    }
    if (msg.type === "complete") {
      jobs.delete(msg.streamId);
      try {
        await deps.downloads.download({
          url: msg.blobUrl,
          filename: msg.filename,
          conflictAction: "uniquify",
        });
        return { type: "job-complete", streamId: msg.streamId, path: msg.filename };
      } catch (err) {
        return {
          type: "job-failed",
          streamId: msg.streamId,
          error: {
            code: "browser_download_failed",
            severity: "terminal",
            reason: err instanceof Error ? err.message : String(err),
            filename: msg.filename,
          },
        };
      }
    }
    if (msg.type === "failed") {
      jobs.delete(msg.streamId);
      return { type: "job-failed", streamId: msg.streamId, error: msg.error };
    }
    return null;
  }

  async function handlePopupMessage(
    msg: PopupToBackgroundMessage,
  ): Promise<BackgroundToPopupMessage | { ok: true } | null> {
    if (msg.type === "list") {
      return { type: "descriptors", tabId: msg.tabId, descriptors: listDescriptors(msg.tabId) };
    }
    if (msg.type === "download") {
      const err = await startDownload(msg.streamId, msg.choice);
      if (err) {
        const failMsg: BackgroundToPopupMessage = { type: "job-failed", streamId: msg.streamId, error: err };
        deps.runtime.sendMessage(failMsg);
      }
      return { ok: true };
    }
    if (msg.type === "cancel") {
      jobs.delete(msg.streamId);
      const engineMsg: BackgroundToEngineMessage = { type: "cancel-job", streamId: msg.streamId };
      deps.runtime.sendMessage(engineMsg);
      return { ok: true };
    }
    return null;
  }

  return {
    tabs,
    jobs,
    addDescriptor,
    listDescriptors,
    findDescriptor,
    clearTab,
    startDownload,
    startBestDownload,
    handleEngineMessage,
    handlePopupMessage,
  };
}
