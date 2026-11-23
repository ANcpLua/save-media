import {
  dispatch,
  type StreamDescriptor,
  type UserChoice,
  type JobError,
  type JobPlan,
  type DispatchRefusal,
  hasPendingHlsPair,
} from "@savemedia/core";
import type {
  BackgroundToEngineMessage,
  DescriptorsMessage,
  DiscoveryFailure,
  DownloadResult,
  EngineEvent,
  EngineHello,
  JobStatus,
} from "../types/messages";
import type { EngineChannel, EngineLoss } from "./engine-channel";
import type { EventHub } from "./events";
import type { SavePermit } from "./session-saves";
import type { JobOrigin, JobPhase, JobRecord, PermitData, PlanKind, TabRecord } from "./state/records";
import type { Logger } from "../util/logger";
import { contentId } from "../util/content-id";
import { suggestFilename, timestampedPath } from "../util/filename";
import { dispatchRefusalToError } from "../util/dispatch-refusal";
import { downloadOptions } from "../util/downloadable";
import { sourceAddress, validatedIdentity } from "../util/media-address";
import { playlistIdentity } from "../util/media-url";
import type { PageReachKind } from "../util/page-reach";
import { directResumeScope, type TransferStage } from "../types/transfer";
import { rowBytes, thinDescriptor } from "../util/thin-descriptor";

export { dispatchRefusalToError } from "../util/dispatch-refusal";

type StreamId = StreamDescriptor["id"];

type HlsDescriptor = StreamDescriptor & {
  readonly source: { readonly kind: "hls-manifest"; readonly manifestUrl: string; readonly type: "master" | "media" };
};

/** The user stopped the save: a neutral end. It carries no error and is never shown as a failure. */
const CANCELLED: JobStatus = { phase: "cancelled" };

/** Chrome names a download the user stopped USER_CANCELED; everything else is a failed save. */
function saveEnd(err: unknown, filename: string): JobStatus {
  if (err instanceof Error && err.message === "USER_CANCELED") return CANCELLED;
  return { phase: "failed", error: { code: "browser_download_failed", severity: "terminal",
    reason: err instanceof Error ? err.message : String(err), filename } };
}

/** The same stage as before, and for a wait the same wait: its time keeps counting from when it began. */
function sameStage(before: TransferStage, after: TransferStage): boolean {
  if (before.kind !== after.kind) return false;
  if (before.kind === "retrying" && after.kind === "retrying") {
    return before.attempt === after.attempt && before.waitMs === after.waitMs && before.part?.index === after.part?.index;
  }
  if (before.kind === "reconnecting" && after.kind === "reconnecting") return before.waitMs === after.waitMs;
  return true;
}

export interface TabState {
  lastNamedStream?: StreamId;
  readonly descriptors: Map<string, StreamDescriptor>;
  /** Segment and init addresses of known HLS playlists, as content ids: never standalone videos. Bounded, oldest first out. */
  readonly hlsCoveredDirectUrls: Set<string>;
  /** Playlists whose segments are already in that set. */
  readonly hlsIndexedPlaylists: Set<string>;
  readonly failures: Map<string, DiscoveryFailure>;
  reach: PageReachKind | null;
}

/** Where the router's state goes so that a worker restart keeps it. Every call is queued; durable() waits for the queue. */
export interface RouterPersistence {
  tab(record: TabRecord): void;
  descriptor(tabId: number, descriptor: StreamDescriptor): void;
  dropDescriptor(tabId: number, id: string): void;
  covered(tabId: number, ids: readonly string[]): void;
  /** Delete everything stored for the tab, with these descriptor rows. */
  dropTab(tabId: number, ids: readonly string[]): void;
  jobs(records: readonly JobRecord[]): void;
  durable(): Promise<void>;
}

export interface RouterDeps {
  readonly engine: Pick<EngineChannel, "start" | "cancel" | "release" | "ack" | "isPending">;
  readonly downloads: {
    /** Resolves with the download's id once the browser accepted it. */
    download: (opts: { url: string; filename: string; conflictAction?: string }) => Promise<number>;
    /** Resolves when the browser finished writing the file; rejects when it did not. Absent: accepted means written. */
    wait?: (downloadId: number) => Promise<unknown>;
    filename?: (downloadId: number) => Promise<string | undefined>;
    /** The download the browser already has for this Blob address, after a worker restart. */
    findByUrl?: (url: string) => Promise<number | null>;
  };
  readonly reserveSave?: (descriptor: StreamDescriptor, choice: UserChoice, file: NamedFile | undefined,
    context: { readonly origin: JobOrigin; readonly allowRepeat: boolean }) => Promise<SavePermit | null>;
  /**
   * Adds what the browser reported about the job's own requests to a failure the network can explain.
   * `address` is the job's source, for a failure that names no server itself. It reads; it requests nothing.
   */
  readonly explainNetwork?: (error: JobError, context: { readonly since: number; readonly address: string;
    readonly tabId: number; readonly pageUrl: string }) => JobError;
  /** The permit of a job that was restored from its record. */
  readonly permitFrom?: (data: PermitData) => SavePermit;
  readonly events?: EventHub;
  readonly persist?: RouterPersistence;
  /** Rows the per-tab limit never drops, besides running jobs: what the selection shows as the main video. */
  readonly keep?: (tabId: number) => ReadonlySet<string>;
  /** The page whose Referer the check of this row sent: the frame that loaded it. A save's requests send the same. */
  readonly referrerOf?: (descriptor: StreamDescriptor) => string | null;
  /**
   * The origins inside the user's network that the browser itself was answered from in this tab. A save
   * takes them along: for a page on the internet it requests no other server there.
   */
  readonly localOriginsOf?: (tabId: number) => readonly string[];
  readonly now?: () => number;
  readonly logger?: Logger;
}

interface ActiveJob {
  readonly permit?: SavePermit | undefined;
  readonly fileName?: string | undefined;
  readonly descriptor: StreamDescriptor;
  readonly choice: UserChoice;
  readonly planKind: PlanKind | null;
  readonly origin: JobOrigin;
  /** The page whose Referer the job's requests send, fixed when the save starts. Null: the tab's page. */
  readonly referrer: string | null;
  /** The tab's document count when the save was accepted, or when the tab reloaded the same address. */
  generation: number;
  phase: JobPhase;
  output: { blobUrl: string; filename: string; downloadId: number | null } | null;
  /** When this worker accepted the save, in ms since the epoch: what the browser reported about its requests counts from here. */
  readonly startedAt: number;
  /** The user cancelled while the engine was still being opened. */
  cancelled?: boolean;
  /** This worker instance is handing the job to the engine: start() ends it, nothing else does. */
  launching?: boolean;
  /** The one hand-over of the finished file to the browser. A second report of the result joins it. */
  writing?: Promise<void>;
}

export type BestDownloadOutcome =
  | { readonly kind: "started"; readonly streamId: StreamId }
  | { readonly kind: "skipped" }
  | { readonly kind: "no-media" }
  | { readonly kind: "failed"; readonly streamId: StreamId; readonly error: JobError };

export interface NamedFile {
  readonly pageUrl: string;
  readonly filename: string;
}

export interface StartOptions {
  readonly file?: NamedFile | undefined;
  readonly origin?: JobOrigin | undefined;
  /** The user pressed "Save another copy": the question whether to save the file again is answered. */
  readonly allowRepeat?: boolean | undefined;
}

/** The stored router state of every tab, as rehydrate hands it back. */
export interface RouterImport {
  readonly tabs: ReadonlyMap<number, TabRecord>;
  readonly descriptors: ReadonlyMap<number, ReadonlyMap<string, StreamDescriptor>>;
  readonly covered: ReadonlyMap<number, readonly string[]>;
  readonly jobs: readonly JobRecord[];
}

export interface Router {
  readonly addDescriptor: (tabId: number, descriptor: StreamDescriptor) => boolean;
  /** Every descriptor of the tab. What is listed and which one is the main video is the selector's answer. */
  readonly descriptors: (tabId: number) => readonly StreamDescriptor[];
  readonly failures: (tabId: number) => readonly DiscoveryFailure[];
  readonly removeDescriptors: (tabId: number, ids: readonly StreamId[]) => number;
  readonly removeFailures: (tabId: number, urls: readonly string[]) => number;
  /** A master playlist gains what its media playlist states about its timeline. */
  readonly annotate: (tabId: number, id: StreamId, patch: { readonly presentation: NonNullable<StreamDescriptor["presentation"]> }) => boolean;
  readonly activeJobs: (tabId: number) => ReadonlySet<string>;
  /** The stream the tab's last named save went to: its row stays visible. */
  readonly lastNamed: (tabId: number) => StreamId | undefined;
  readonly setDiscoveryFailure: (tabId: number, failure: DiscoveryFailure) => void;
  readonly clearDiscoveryFailure: (tabId: number, url: string) => boolean;
  readonly snapshot: (tabId: number) => DescriptorsMessage;
  readonly findDescriptor: (id: StreamId) => StreamDescriptor | null;
  /** The tab shows a new top document. A save of the same address stays attached to it. */
  readonly clearTab: (tabId: number, pageUrl?: string) => void;
  /** The tab is closed: everything of it goes; a running save finishes on its own. */
  readonly forgetTab: (tabId: number) => void;
  /** How many top documents the tab has shown. Work that began under another count belongs to a page that is gone. */
  readonly generation: (tabId: number) => number;
  readonly pageReach: (tabId: number) => PageReachKind | null;
  readonly setPageReach: (tabId: number, reach: PageReachKind | null) => void;
  /** The running save of a stream: its tab, page and document. */
  readonly job: (id: string) => { readonly tabId: number; readonly pageUrl: string; readonly referrer: string | null; readonly generation: number;
    readonly origin: JobOrigin } | null;
  /** Saves that still need the engine document: starting, running, or being written to disk. */
  readonly engineJobCount: () => number;
  readonly startDownload: (id: StreamId, choice: UserChoice, options?: StartOptions) => Promise<DownloadResult>;
  /** Start the first of these that can be saved, in the given order. */
  readonly startSelected: (tabId: number, ids: readonly StreamId[], file?: NamedFile, origin?: JobOrigin,
    options?: { readonly allowRepeat?: boolean }) => Promise<BestDownloadOutcome>;
  readonly cancel: (id: StreamId) => void;
  /** A Save from a card that could not start: its row shows why, also when the popup is opened again. */
  readonly recordFailure: (id: StreamId, error: JobError) => void;
  readonly handleEngineMessage: (msg: EngineEvent) => Promise<void>;
  /** The engine is gone: fail what it was running and stop promising its kept bytes. */
  readonly failEngineJobs: (when: EngineLoss) => Promise<void>;
  /** The engine's own account after a (re)connect. */
  readonly reconcileEngine: (hello: EngineHello) => Promise<void>;
  /** After a worker restart: finish the saves whose file the browser was writing. */
  readonly resumeWriting: () => Promise<void>;
  /** Replace the empty initial state with the stored one. Called once, before anything else touches the router. */
  readonly importState: (state: RouterImport) => void;
  /** Tabs with router state, for choosing what to drop when the store is full. */
  readonly storedTabs: () => readonly { readonly tabId: number; readonly ids: readonly string[]; readonly hasJob: boolean }[];
}

/** Rows one tab keeps. Beyond it the oldest row that is neither saving nor the main video goes. */
export const MAX_DESCRIPTORS_PER_TAB = 200;
/** The most text one tab's rows hold together. Rows go by the same rule beyond it. */
export const MAX_TAB_ROW_BYTES = 4 * 1024 * 1024;
const MAX_FAILURES = 20;
const MAX_COVERED_URLS = 4096;
const COUNTER_ID = /^stream-\d+$/;

function planKindOf(plan: JobPlan | DispatchRefusal): PlanKind | null {
  return plan.kind === "refuse" ? null : plan.kind;
}

export function createRouter(deps: RouterDeps): Router {
  const tabs = new Map<number, TabState>();
  const jobs = new Map<StreamId, ActiveJob>();
  const statuses = new Map<string, { readonly tabId: number; readonly status: JobStatus }>();
  /** Stream id to the resume scope of a failed status that promises kept bytes. */
  const retainedBy = new Map<string, string>();
  const generations = new Map<number, number>();
  const now = deps.now ?? Date.now;
  let imported = false;

  const generation = (tabId: number): number => generations.get(tabId) ?? 0;

  function getTab(tabId: number): TabState {
    let s = tabs.get(tabId);
    if (!s) {
      s = { descriptors: new Map(), hlsCoveredDirectUrls: new Set(), hlsIndexedPlaylists: new Set(), failures: new Map(), reach: null };
      tabs.set(tabId, s);
    }
    return s;
  }

  // ---- persistence -------------------------------------------------------

  function tabRecord(tabId: number): TabRecord {
    const state = tabs.get(tabId);
    const own: Record<string, JobStatus> = {};
    const kept: Record<string, string> = {};
    for (const [id, entry] of statuses) {
      // A running save is restored from its job record, with the engine's own progress.
      if (entry.tabId !== tabId || jobs.has(id as StreamId)) continue;
      own[id] = entry.status;
      const scope = retainedBy.get(id);
      if (scope !== undefined) kept[id] = scope;
    }
    return {
      v: 1, tabId, generation: generation(tabId),
      order: [...(state?.descriptors ?? [])].map(([key, d]) => ({ key, id: d.id })),
      indexedPlaylists: [...(state?.hlsIndexedPlaylists ?? [])],
      failures: [...(state?.failures.values() ?? [])],
      lastNamedStream: state?.lastNamedStream ?? null,
      statuses: own, retainedBy: kept, reach: state?.reach ?? null, touchedAt: now(),
    };
  }

  const saveTab = (tabId: number): void => deps.persist?.tab(tabRecord(tabId));
  const saveCovered = (tabId: number): void => deps.persist?.covered(tabId, [...(tabs.get(tabId)?.hlsCoveredDirectUrls ?? [])]);

  function jobRecords(): JobRecord[] {
    return [...jobs].map(([streamId, job]) => ({
      v: 1, streamId, tabId: job.descriptor.tabId, generation: job.generation, origin: job.origin, descriptor: job.descriptor,
      choice: job.choice, fileName: job.fileName ?? null, planKind: job.planKind, referrer: job.referrer,
      permit: job.permit?.receiptKey ? { receiptKey: job.permit.receiptKey, resumeKey: job.permit.resumeKey ?? null } : null,
      phase: job.phase, output: job.output ? { ...job.output } : null,
    }));
  }
  const saveJobs = (): void => deps.persist?.jobs(jobRecords());
  const durable = (): Promise<void> => deps.persist?.durable() ?? Promise.resolve();

  // ---- statuses ----------------------------------------------------------

  /** Set a stream's status and tell the observers. `tabId` is needed only when no job names the tab. */
  function setStatus(id: StreamId, status: JobStatus, context?: { readonly tabId: number; readonly origin: JobOrigin; readonly generation: number }): void {
    const job = jobs.get(id);
    const tabId = job?.descriptor.tabId ?? context?.tabId ?? statuses.get(id)?.tabId;
    if (tabId === undefined) return;
    const previous = statuses.get(id)?.status ?? null;
    // A stage keeps the time it began while it lasts, so a wait counts down from one moment.
    const stageSince = status.phase !== "active" || !status.stage ? undefined
      : previous?.phase === "active" && previous.stage && previous.stageSince !== undefined && sameStage(previous.stage, status.stage)
        ? previous.stageSince : now();
    const next = { ...status, ...(stageSince !== undefined ? { stageSince } : {}),
      ...(job?.fileName ? { fileName: job.fileName } : previous?.fileName ? { fileName: previous.fileName } : {}) };
    statuses.set(id, { tabId, status: next });
    if (!next.retained) retainedBy.delete(id);
    deps.events?.emit({ type: "job", tabId, generation: job?.generation ?? context?.generation ?? generation(tabId), streamId: id,
      origin: job?.origin ?? context?.origin ?? "popup", status: next, previous });
  }

  function dropStatus(id: string): void {
    statuses.delete(id);
    retainedBy.delete(id);
  }

  function descriptorKey(d: StreamDescriptor): string {
    const src = d.source.kind === "direct-url"
      ? d.source.url
      : d.source.kind === "hls-manifest" || d.source.kind === "dash-manifest"
        ? d.source.manifestUrl
        : d.source.elementSrc;
    return `${d.source.kind}:${d.protocol}:${d.drm?.reason ?? ""}:${normalizedUrl(src)}`;
  }

  /** One identity for every reload of a playlist: the address without the fragment or the HLS delivery directives. */
  function normalizedUrl(url: string): string {
    try {
      return playlistIdentity(new URL(url).href);
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

  /** Once per playlist identity: a reload of a live playlist adds nothing. */
  function indexHlsCoveredDirectUrls(state: TabState, d: StreamDescriptor): boolean {
    const playlist = d.source.kind === "hls-manifest" ? normalizedUrl(d.source.manifestUrl) : null;
    if (playlist === null || state.hlsIndexedPlaylists.has(playlist)) return false;
    state.hlsIndexedPlaylists.add(playlist);
    if (state.hlsIndexedPlaylists.size > 256) state.hlsIndexedPlaylists.delete(state.hlsIndexedPlaylists.values().next().value!);
    for (const url of hlsCoveredDirectUrls(d)) {
      state.hlsCoveredDirectUrls.add(contentId([url]));
      if (state.hlsCoveredDirectUrls.size > MAX_COVERED_URLS) state.hlsCoveredDirectUrls.delete(state.hlsCoveredDirectUrls.values().next().value!);
    }
    return true;
  }

  function removeHlsCoveredDirectDescriptors(state: TabState): number {
    if (state.hlsCoveredDirectUrls.size === 0) return 0;
    let removed = 0;
    for (const [key, existing] of state.descriptors.entries()) {
      const url = directUrl(existing);
      if (url && state.hlsCoveredDirectUrls.has(contentId([url]))) {
        state.descriptors.delete(key);
        removed++;
      }
    }
    return removed;
  }

  function isHlsCoveredDirectDescriptor(state: TabState, d: StreamDescriptor): boolean {
    const url = directUrl(d);
    return url !== null && state.hlsCoveredDirectUrls.has(contentId([url]));
  }

  function hlsVariantPlaylistUrls(d: StreamDescriptor): Set<string> {
    const urls = new Set<string>();
    if (d.protocol !== "hls") return urls;
    for (const v of d.variants) {
      if (v.segmentRef.kind === "hls-segments") urls.add(normalizedUrl(v.segmentRef.playlistUrl));
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
      if (isHlsMediaPlaylist(existing) && covered.has(normalizedUrl(existing.source.manifestUrl))) {
        state.descriptors.delete(k);
      }
    }
  }

  function hlsMediaCoveredByExistingMaster(state: TabState, media: StreamDescriptor): boolean {
    if (!isHlsMediaPlaylist(media)) return false;
    for (const existing of state.descriptors.values()) {
      if (isHlsMasterPlaylist(existing) && hlsVariantPlaylistUrls(existing).has(normalizedUrl(media.source.manifestUrl))) {
        return true;
      }
    }
    return false;
  }

  /** A row's id: derived from the tab and what the row is, so the same source gets the same id in every worker instance. */
  function assignId(state: TabState, tabId: number, key: string, descriptor: StreamDescriptor): StreamId {
    // Only the classifier's counter ids are replaced: the counter starts again with every worker.
    if (!COUNTER_ID.test(descriptor.id)) return descriptor.id;
    const base = `stream-${contentId([tabId, key])}`;
    const taken = new Set<string>();
    for (const [otherKey, other] of state.descriptors) if (otherKey !== key) taken.add(other.id);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id as StreamId;
  }

  /** Keep a tab's rows bounded, by count and by size: the oldest row that is neither saving, named nor the main video goes. */
  function enforceLimit(tabId: number, state: TabState, added: string): void {
    let bytes = 0;
    for (const d of state.descriptors.values()) bytes += rowBytes(d);
    const over = (): boolean => state.descriptors.size > MAX_DESCRIPTORS_PER_TAB || bytes > MAX_TAB_ROW_BYTES;
    if (!over()) return;
    const keep = deps.keep?.(tabId);
    for (const [key, d] of state.descriptors) {
      if (!over()) break;
      if (key === added || jobs.has(d.id) || state.lastNamedStream === d.id || keep?.has(d.id)) continue;
      state.descriptors.delete(key);
      bytes -= rowBytes(d);
      dropStatus(d.id);
      deps.persist?.dropDescriptor(tabId, d.id);
    }
  }

  function addDescriptor(tabId: number, descriptor: StreamDescriptor): boolean {
    const state = getTab(tabId);
    const before = new Map(state.descriptors);
    const coveredBefore = state.hlsCoveredDirectUrls.size;
    const indexedBefore = state.hlsIndexedPlaylists.size;
    const changed = insert(tabId, state, descriptor);
    // Store what this call changed: rows that went, the row that came or was replaced, and the order.
    let rows = false;
    for (const [key, old] of before) {
      const current = state.descriptors.get(key);
      if (current?.id !== old.id && ![...state.descriptors.values()].some(d => d.id === old.id)) { deps.persist?.dropDescriptor(tabId, old.id); rows = true; }
    }
    for (const [key, current] of state.descriptors) {
      if (before.get(key) !== current) { deps.persist?.descriptor(tabId, current); rows = true; }
    }
    const covered = state.hlsCoveredDirectUrls.size !== coveredBefore || state.hlsIndexedPlaylists.size !== indexedBefore;
    if (covered) saveCovered(tabId);
    if (rows || covered) saveTab(tabId);
    return changed;
  }

  function insert(tabId: number, state: TabState, full: StreamDescriptor): boolean {
    let removedCoveredDirects = 0;
    if (full.protocol === "hls" && indexHlsCoveredDirectUrls(state, full)) {
      removedCoveredDirects = removeHlsCoveredDirectDescriptors(state);
    }
    // The segment list was read for the index above. The row keeps a sample: a save reads the playlist again.
    const descriptor = thinDescriptor(full);

    if (hlsMediaCoveredByExistingMaster(state, descriptor)) return removedCoveredDirects > 0;
    if (isHlsMasterPlaylist(descriptor)) removeCoveredHlsMediaDescriptors(state, descriptor);
    if (isHlsCoveredDirectDescriptor(state, descriptor)) return false;

    const key = descriptorKey(descriptor);
    const aliases = directAliases(descriptor);
    const matches = aliases.length > 0
      ? [...state.descriptors.values()].filter(d => directAliases(d).some(url => aliases.includes(url))) : [];
    const existing = state.descriptors.get(key) ?? matches[0];
    if (!existing) {
      const renewed = renewedLink(state, descriptor);
      if (renewed) state.descriptors.delete(descriptorKey(renewed));
      const row = renewed ? { ...descriptor, id: renewed.id, title: descriptor.title ?? renewed.title }
        : { ...descriptor, id: assignId(state, tabId, key, descriptor) };
      state.descriptors.set(key, row);
      enforceLimit(tabId, state, key);
      deps.events?.emit({ type: "source", tabId, generation: generation(tabId), descriptor: row });
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
    enforceLimit(tabId, state, key);
    return true;
  }

  /**
   * The page's own fresh capture of a file it already offered: another link
   * whose verified response states the same origin, path, length and strong
   * validator. The row keeps its identity and takes the fresh link, so a save
   * uses the link the page issued last. No query parameter is interpreted.
   */
  function renewedLink(state: TabState, descriptor: StreamDescriptor): StreamDescriptor | undefined {
    if (descriptor.source.kind !== "direct-url" || !descriptor.capabilities.directDownload || descriptor.mediaGroup) return undefined;
    const identity = validatedIdentity(descriptor.source.url, descriptor.source.headers);
    if (!identity) return undefined;
    return [...state.descriptors.values()].find(d => d.source.kind === "direct-url" && d.capabilities.directDownload && !d.mediaGroup
      && d.pageUrl === descriptor.pageUrl && d.detectedAt <= descriptor.detectedAt
      && validatedIdentity(d.source.url, d.source.headers) === identity);
  }

  function listDescriptors(tabId: number): readonly StreamDescriptor[] {
    return [...(tabs.get(tabId)?.descriptors.values() ?? [])];
  }

  function removeDescriptors(tabId: number, ids: readonly StreamId[]): number {
    const state = tabs.get(tabId);
    if (!state) return 0;
    let removed = 0;
    for (const [key, descriptor] of state.descriptors) {
      // A running save keeps its row: the transfer still belongs to the tab.
      if (!ids.includes(descriptor.id) || jobs.has(descriptor.id)) continue;
      state.descriptors.delete(key);
      dropStatus(descriptor.id);
      deps.persist?.dropDescriptor(tabId, descriptor.id);
      removed++;
    }
    if (removed) saveTab(tabId);
    return removed;
  }

  function annotate(tabId: number, id: StreamId, patch: { readonly presentation: NonNullable<StreamDescriptor["presentation"]> }): boolean {
    const state = tabs.get(tabId);
    for (const [key, descriptor] of state?.descriptors ?? []) {
      if (descriptor.id !== id) continue;
      const known = descriptor.presentation;
      if (known && known.live === patch.presentation.live && known.durationSeconds === patch.presentation.durationSeconds
        && known.maxSegmentSeconds === patch.presentation.maxSegmentSeconds) return false;
      const next = { ...descriptor, presentation: patch.presentation };
      state!.descriptors.set(key, next);
      deps.persist?.descriptor(tabId, next);
      return true;
    }
    return false;
  }

  function activeJobs(tabId: number): ReadonlySet<string> {
    return new Set([...jobs.values()].filter(job => job.descriptor.tabId === tabId).map(job => job.descriptor.id));
  }

  function findDescriptor(id: StreamId): StreamDescriptor | null {
    for (const state of tabs.values()) {
      for (const d of state.descriptors.values()) if (d.id === id) return d;
    }
    return null;
  }

  function dropTabState(tabId: number): readonly string[] {
    const ids = [...(tabs.get(tabId)?.descriptors.values() ?? [])].map(d => d.id);
    tabs.delete(tabId);
    for (const [id, entry] of [...statuses]) if (entry.tabId === tabId && !jobs.has(id as StreamId)) dropStatus(id);
    return ids;
  }

  function clearTab(tabId: number, pageUrl?: string): void {
    const ids = dropTabState(tabId);
    generations.set(tabId, generation(tabId) + 1);
    deps.persist?.dropTab(tabId, ids);
    // A page reload replaces its captures. The transfer still belongs to
    // this tab and document address, and the popup can rejoin it immediately.
    let rejoined = false;
    if (pageUrl) {
      for (const job of jobs.values()) {
        const { descriptor, fileName } = job;
        if (descriptor.tabId !== tabId || descriptor.pageUrl !== pageUrl) continue;
        job.generation = generation(tabId);
        addDescriptor(tabId, descriptor);
        if (fileName) getTab(tabId).lastNamedStream = descriptor.id;
        rejoined = true;
      }
    }
    if (rejoined) saveJobs();
    saveTab(tabId);
    deps.events?.emit({ type: "document", tabId, generation: generation(tabId), closed: false });
  }

  function forgetTab(tabId: number): void {
    const ids = dropTabState(tabId);
    const last = generation(tabId);
    generations.delete(tabId);
    deps.persist?.dropTab(tabId, ids);
    deps.events?.emit({ type: "document", tabId, generation: last + 1, closed: true });
  }

  function setDiscoveryFailure(tabId: number, failure: DiscoveryFailure): void {
    const state = getTab(tabId);
    state.failures.set(failure.url, failure);
    // Bound failed network candidates, including pages with many broken fragments.
    if (state.failures.size > MAX_FAILURES) state.failures.delete(state.failures.keys().next().value!);
    saveTab(tabId);
    deps.events?.emit({ type: "source-failure", tabId, generation: generation(tabId), failure });
  }

  function clearDiscoveryFailure(tabId: number, url: string): boolean {
    const cleared = tabs.get(tabId)?.failures.delete(url) ?? false;
    if (cleared) saveTab(tabId);
    return cleared;
  }

  function listDiscoveryFailures(tabId: number): readonly DiscoveryFailure[] {
    return [...(tabs.get(tabId)?.failures.values() ?? [])];
  }

  function removeFailures(tabId: number, urls: readonly string[]): number {
    const state = tabs.get(tabId);
    if (!state) return 0;
    const gone = new Set(urls.map(normalizedUrl));
    let removed = 0;
    for (const url of [...state.failures.keys()]) {
      if (gone.has(normalizedUrl(url)) && state.failures.delete(url)) removed++;
    }
    if (removed) saveTab(tabId);
    return removed;
  }

  function snapshot(tabId: number): DescriptorsMessage {
    const descriptors = [...listDescriptors(tabId)];
    const lastNamed = tabs.get(tabId)?.lastNamedStream;
    const lastDescriptor = lastNamed && findDescriptor(lastNamed);
    // Reopening the popup can rescan a preview or a fresh signed URL while
    // the original job still holds the name Chrome assigned on disk.
    if (lastDescriptor && !descriptors.some(d => d.id === lastDescriptor.id)) descriptors.push(lastDescriptor);
    return { type: "descriptors", tabId, descriptors,
      failures: listDiscoveryFailures(tabId),
      statuses: Object.fromEntries(descriptors.flatMap(d => {
        const status = statuses.get(d.id)?.status;
        return status ? [[d.id, status]] : [];
      })),
    };
  }

  /**
   * Start the first of the selected descriptors that can be saved. When none
   * can, say why: protected media is refused with its protection, never
   * reported as "nothing here", and media the engine cannot finish names its
   * refusal.
   */
  async function startSelected(tabId: number, ids: readonly StreamId[], file?: NamedFile, origin: JobOrigin = "popup",
    options: { readonly allowRepeat?: boolean } = {}): Promise<BestDownloadOutcome> {
    if (file) {
      for (const [streamId, { descriptor, fileName }] of jobs) {
        if (descriptor.tabId === tabId && descriptor.pageUrl === file.pageUrl
          && fileName === file.filename) {
          return { kind: "started", streamId };
        }
      }
    }
    const all = listDescriptors(tabId);
    const descriptors = ids.flatMap(id => all.filter(d => d.id === id));
    const best = descriptors.map(d => downloadOptions(d)[0]).find(option => option !== undefined);
    if (!best) {
      const protectedMedia = descriptors.find(d => d.drm);
      if (protectedMedia?.drm) {
        return {
          kind: "failed",
          streamId: protectedMedia.id,
          error: dispatchRefusalToError(protectedMedia.drm.reason, protectedMedia),
        };
      }
      for (const candidate of descriptors) {
        const plan = dispatch(candidate, { outputMode: "Original", filename: suggestFilename(candidate), variantId: null, audioRenditionId: null });
        if (plan.kind === "refuse") {
          return {
            kind: "failed",
            streamId: candidate.id,
            error: dispatchRefusalToError(plan.reason, candidate, plan),
          };
        }
      }
      return { kind: "no-media" };
    }

    const { descriptor, choice } = best;
    // The name the page gives the file names the original.
    const selected = file && descriptor.capabilities.directDownload
      ? { ...choice, filename: suggestFilename({ ...descriptor, title: file.filename }) } : choice;
    const result = await start(descriptor.id, selected, { file, origin, allowRepeat: options.allowRepeat });
    if (result.outcome === "skipped") return { kind: "skipped" };
    if (result.outcome === "failed") return { kind: "failed", streamId: descriptor.id, error: result.error };
    return result.outcome === "listing-expired" ? { kind: "no-media" } : { kind: "started", streamId: descriptor.id };
  }

  const result = (outcome: "started" | "skipped" | "listing-expired"): DownloadResult => ({ type: "download-result", outcome });
  const failed = (error: JobError): DownloadResult => ({ type: "download-result", outcome: "failed", error });

  /** End a job: release its reservation, record how it ended, and tell the observers. */
  async function finish(id: StreamId, status: JobStatus, saved: boolean, retainedScope?: string | null): Promise<void> {
    const job = jobs.get(id);
    if (!job) return;
    await job.permit?.finish(saved).catch(() => undefined);
    if (jobs.get(id) !== job) return;
    // The status is set while the job still names the tab, origin and document; then the job is gone.
    if (status.retained && retainedScope) retainedBy.set(id, retainedScope);
    setStatus(id, status);
    jobs.delete(id);
    if (status.retained && retainedScope) retainedBy.set(id, retainedScope);
    saveJobs();
    saveTab(job.descriptor.tabId);
  }

  async function start(id: StreamId, choice: UserChoice, options: StartOptions = {}): Promise<DownloadResult> {
    const descriptor = findDescriptor(id);
    // The row is no longer known, after a navigation or a lost store: the popup looks again.
    if (!descriptor) return result("listing-expired");
    if (jobs.has(id)) return result("started");
    const origin = options.origin ?? "popup";
    const context = { tabId: descriptor.tabId, origin, generation: generation(descriptor.tabId) };
    const plan: JobPlan | DispatchRefusal = dispatch(descriptor, choice);

    if (plan.kind === "refuse") {
      // Forward an unmaterialized demuxed pair to the engine host, which
      // materializes both media playlists and re-dispatches authoritatively
      // (engine/download.ts); genuine refusals come back as job-failed.
      if (plan.reason !== "no_usable_variant" || !hasPendingHlsPair(descriptor, choice)) {
        return failed(dispatchRefusalToError(plan.reason, descriptor, plan));
      }
    }

    let permit: SavePermit | null | undefined;
    try {
      permit = await deps.reserveSave?.(descriptor, choice, options.file, { origin, allowRepeat: options.allowRepeat === true });
    } catch (err) {
      const error: JobError = { code: "engine_job_failed", severity: "terminal", at: "init", detail: err instanceof Error ? err.message : String(err) };
      setStatus(id, { phase: "failed", error }, context);
      saveTab(descriptor.tabId);
      return failed(error);
    }
    if (permit === null) return result("skipped");
    // While the reservation waited (a repeat question), another start may have taken the row.
    if (jobs.has(id)) { await permit?.finish(false).catch(() => undefined); return result("started"); }
    const job: ActiveJob = { descriptor, choice, fileName: options.file?.filename, permit: permit ?? undefined, planKind: planKindOf(plan),
      origin, referrer: deps.referrerOf?.(descriptor) ?? null, generation: context.generation, phase: "starting", output: null, launching: true,
      startedAt: now() };
    jobs.set(id, job);
    if (options.file) getTab(descriptor.tabId).lastNamedStream = id;
    setStatus(id, { phase: "active", bytesWritten: 0, bytesTotal: null, stage: { kind: "starting" } });
    saveJobs();
    saveTab(descriptor.tabId);
    deps.events?.emit({ type: "sources-changed", tabId: descriptor.tabId });
    try {
      // The record is stored before the engine hears of the job, so a worker restart finds either both or neither.
      await durable();
      // The job ended while its record was written: the engine never hears of it.
      if (jobs.get(id) !== job) return result("started");
      const localOrigins = deps.localOriginsOf?.(descriptor.tabId) ?? [];
      const engineMsg: Extract<BackgroundToEngineMessage, { type: "start-job" }> = { type: "start-job", streamId: id, descriptor, choice,
        ...(plan.kind === "direct" && permit?.resumeKey ? { resumeKey: permit.resumeKey } : {}),
        ...(localOrigins.length ? { localOrigins } : {}) };
      await deps.engine.start(engineMsg);
    } catch {
      job.launching = false;
      if (jobs.get(id) !== job) return result("started");
      if (job.cancelled) {
        await finish(id, CANCELLED, false);
        return result("skipped");
      }
      const error: JobError = { code: "engine_stopped", severity: "terminal", when: "start" };
      await finish(id, { phase: "failed", error }, false);
      return failed(error);
    }
    job.launching = false;
    if (jobs.get(id) !== job) return result("started");
    if (job.cancelled) {
      // Cancelled while the engine was opening: the job reached it, so it is told to stop.
      deps.engine.cancel(id);
    }
    // The engine may already have reported the result: a job being written stays there.
    if (job.phase === "starting") job.phase = "engine";
    saveJobs();
    return result("started");
  }

  /**
   * Hand the finished file to the browser, once per job. The engine reports
   * a result again after a reconnect, and a restarted worker continues the
   * files that were being written: every caller joins the same hand-over.
   */
  function written(id: StreamId, job: ActiveJob): Promise<void> {
    job.writing ??= write(id, job);
    return job.writing;
  }

  /** Save the engine's finished Blob through the browser's download manager. Called through written() only. */
  async function write(id: StreamId, job: ActiveJob): Promise<void> {
    const output = job.output!;
    try {
      if (output.downloadId === null) {
        output.downloadId = await deps.downloads.findByUrl?.(output.blobUrl).catch(() => null) ?? null;
      }
      if (output.downloadId === null) {
        output.downloadId = await deps.downloads.download({ url: output.blobUrl, filename: output.filename, conflictAction: "uniquify" });
        saveJobs();
      }
      await deps.downloads.wait?.(output.downloadId);
      const savedAs = await deps.downloads.filename?.(output.downloadId).catch(() => undefined) ?? output.filename;
      await finish(id, { phase: "complete", savedAs }, true);
    } catch (err) {
      await finish(id, saveEnd(err, output.filename), false);
    }
    // The file is on disk or given up, and that is stored: the engine may drop the Blob.
    await durable();
    if (output.blobUrl.startsWith("blob:")) deps.engine.release(output.blobUrl);
  }

  async function handleEngineMessage(msg: EngineEvent): Promise<void> {
    if (msg.type === "transfer-http") {
      const job = jobs.get(msg.streamId);
      if (job) deps.events?.emit({ type: "http", tabId: job.descriptor.tabId, generation: job.generation, source: "transfer",
        streamId: msg.streamId, observation: msg.observation });
      return;
    }
    if (msg.type === "progress") {
      const job = jobs.get(msg.streamId);
      // Progress of a job that already ended, or that is being written, changes nothing.
      if (!job || job.phase === "writing") return;
      setStatus(msg.streamId, { phase: "active", bytesWritten: msg.bytesWritten, bytesTotal: msg.bytesTotal, stage: msg.stage });
      return;
    }
    if (msg.type === "complete") {
      const job = jobs.get(msg.streamId);
      if (!job) {
        // The result of a save that is already recorded as ended: only the Blob is left to free.
        if (msg.blobUrl.startsWith("blob:")) deps.engine.release(msg.blobUrl);
        return;
      }
      // Reported again after a reconnect: the first report is being written.
      if (job.phase === "writing") return;
      job.phase = "writing";
      job.output = { blobUrl: msg.blobUrl, filename: job.planKind !== "direct" ? timestampedPath(msg.filename) : msg.filename, downloadId: null };
      setStatus(msg.streamId, { phase: "active", bytesWritten: 0, bytesTotal: null, stage: { kind: "writing" } });
      saveJobs();
      // Stored before the browser is asked, so a restart continues this download and never starts a second one.
      await durable();
      // The job may have been picked up by resumeWriting() meanwhile: there is one hand-over either way.
      if (jobs.get(msg.streamId) === job) await written(msg.streamId, job);
      return;
    }
    if (msg.type === "failed") {
      const { retained } = msg;
      const job = jobs.get(msg.streamId);
      if (job && job.phase !== "writing") {
        if (msg.error.code === "user_cancelled") {
          await finish(msg.streamId, CANCELLED, false);
        } else {
          // What the browser reported about the job's own requests explains a network failure. Nothing is requested for it.
          const error = deps.explainNetwork?.(msg.error as JobError, { since: job.startedAt, address: sourceAddress(job.descriptor),
            tabId: job.descriptor.tabId, pageUrl: job.descriptor.pageUrl }) ?? msg.error as JobError;
          // Kept bytes are named as the engine names them, so a later hello can confirm they are still there.
          const resumeKey = job.permit?.resumeKey;
          await finish(msg.streamId, { phase: "failed", error, ...(retained ? { retained } : {}) }, false,
            retained && resumeKey ? directResumeScope(job.descriptor.tabId, resumeKey) : null);
        }
        await durable();
      }
      deps.engine.ack(msg.streamId);
      return;
    }
    if (msg.type === "retained-released") {
      // The failure stands; only its promise of kept bytes ends.
      stripRetained(msg.streamId);
    }
    // Engine lifetime, request preparation and image saves are not job status.
  }

  function stripRetained(id: string): void {
    const entry = statuses.get(id);
    retainedBy.delete(id);
    if (entry?.status.phase !== "failed" || !entry.status.error || !entry.status.retained) return;
    const { retained: _released, ...rest } = entry.status;
    setStatus(id as StreamId, rest, { tabId: entry.tabId, origin: "popup", generation: generation(entry.tabId) });
    saveTab(entry.tabId);
  }

  async function failEngineJobs(when: EngineLoss): Promise<void> {
    for (const [id, job] of [...jobs]) {
      // A start of this worker instance ends on its own, also when it has not asked for the engine yet;
      // a file being written is the browser's now.
      if (job.phase === "writing" || job.launching || deps.engine.isPending(id)) continue;
      await finish(id, job.cancelled ? CANCELLED : { phase: "failed", error: { code: "engine_stopped", severity: "terminal", when } }, false);
    }
    // The kept bytes lived in the engine that is gone.
    for (const [id, entry] of [...statuses]) if (entry.status.retained) stripRetained(id);
    await durable();
  }

  async function reconcileEngine(hello: EngineHello): Promise<void> {
    const reported = new Set<string>();
    for (const kept of hello.outbox) {
      if (kept.type === "image-complete") continue;
      reported.add(kept.streamId);
      // Not awaited: a file being written must not hold back the engine's welcome.
      void handleEngineMessage(kept).catch(() => undefined);
    }
    for (const [id, scope] of [...retainedBy]) if (scope !== hello.retained) stripRetained(id);
    for (const [id, entry] of [...statuses]) if (entry.status.retained && !retainedBy.has(id)) stripRetained(id);
    const active = new Map(hello.active.map(item => [item.streamId as string, item.progress]));
    for (const [id, job] of [...jobs]) {
      // A start of this worker instance has not reached the engine yet, so the engine cannot name it: start() ends it.
      if (job.phase === "writing" || reported.has(id) || job.launching || deps.engine.isPending(id)) continue;
      const progress = active.get(id);
      if (progress === undefined) {
        // Not running and no result kept: the engine that ran it is gone.
        await finish(id, { phase: "failed", error: { code: "engine_stopped", severity: "terminal", when: "restart" } }, false);
        continue;
      }
      job.phase = "engine";
      if (progress) setStatus(id, { phase: "active", ...progress });
    }
    // A job the engine runs for which nothing is recorded any more.
    for (const id of active.keys()) if (!jobs.has(id as StreamId) && !id.startsWith("image:")) deps.engine.cancel(id);
    saveJobs();
  }

  async function resumeWriting(): Promise<void> {
    await Promise.all([...jobs].filter(([, job]) => job.phase === "writing" && job.output).map(([id, job]) => written(id, job)));
  }

  function cancel(id: StreamId): void {
    const job = jobs.get(id);
    if (job?.phase === "starting") job.cancelled = true;
    // Always forwarded: the engine ignores an id it does not run, and a restarted worker may not know the job any more.
    deps.engine.cancel(id);
  }

  function importState(state: RouterImport): void {
    if (imported || tabs.size || jobs.size) throw new Error("router state is imported once, into an empty router");
    imported = true;
    for (const [tabId, record] of state.tabs) {
      const tab = getTab(tabId);
      generations.set(tabId, record.generation);
      const rows = state.descriptors.get(tabId);
      for (const { key, id } of record.order) {
        const descriptor = rows?.get(id);
        if (descriptor) tab.descriptors.set(key, descriptor);
      }
      for (const playlist of record.indexedPlaylists) tab.hlsIndexedPlaylists.add(playlist);
      for (const id of state.covered.get(tabId) ?? []) tab.hlsCoveredDirectUrls.add(id);
      for (const failure of record.failures) tab.failures.set(failure.url, failure);
      if (record.lastNamedStream) tab.lastNamedStream = record.lastNamedStream as StreamId;
      tab.reach = record.reach as PageReachKind | null;
      for (const [id, status] of Object.entries(record.statuses)) statuses.set(id, { tabId, status });
      for (const [id, scope] of Object.entries(record.retainedBy)) retainedBy.set(id, scope);
    }
    for (const record of state.jobs) {
      const permit = record.permit ? deps.permitFrom?.(record.permit) : undefined;
      jobs.set(record.streamId, { descriptor: record.descriptor, choice: record.choice, fileName: record.fileName ?? undefined, permit,
        planKind: record.planKind, origin: record.origin, referrer: record.referrer ?? null, generation: record.generation, phase: record.phase,
        output: record.output ? { ...record.output } : null, startedAt: 0 });
      statuses.set(record.streamId, { tabId: record.tabId, status: { phase: "active", bytesWritten: 0, bytesTotal: null,
        stage: { kind: record.phase === "writing" ? "writing" : "starting" }, ...(record.fileName ? { fileName: record.fileName } : {}) } });
    }
  }

  return {
    addDescriptor,
    descriptors: listDescriptors,
    failures: listDiscoveryFailures,
    removeDescriptors,
    removeFailures,
    annotate,
    activeJobs,
    lastNamed: tabId => tabs.get(tabId)?.lastNamedStream,
    setDiscoveryFailure,
    clearDiscoveryFailure,
    snapshot,
    findDescriptor,
    clearTab,
    forgetTab,
    generation,
    pageReach: tabId => tabs.get(tabId)?.reach ?? null,
    setPageReach(tabId, reach) {
      if ((tabs.get(tabId)?.reach ?? null) === reach) return;
      getTab(tabId).reach = reach;
      saveTab(tabId);
    },
    job(id) {
      const job = jobs.get(id as StreamId);
      return job ? { tabId: job.descriptor.tabId, pageUrl: job.descriptor.pageUrl, referrer: job.referrer, generation: job.generation, origin: job.origin } : null;
    },
    engineJobCount: () => jobs.size,
    startDownload: start,
    startSelected,
    cancel,
    recordFailure(id, error) {
      const descriptor = findDescriptor(id);
      const known = statuses.get(id)?.status;
      if (!descriptor || jobs.has(id) || (known?.phase === "failed" && known.error === error)) return;
      setStatus(id, { phase: "failed", error }, { tabId: descriptor.tabId, origin: "popup", generation: generation(descriptor.tabId) });
      saveTab(descriptor.tabId);
    },
    handleEngineMessage,
    failEngineJobs,
    reconcileEngine,
    resumeWriting,
    importState,
    storedTabs: () => [...new Set([...tabs.keys(), ...generations.keys()])].map(tabId => ({ tabId,
      ids: [...(tabs.get(tabId)?.descriptors.values() ?? [])].map(d => d.id), hasJob: activeJobs(tabId).size > 0 })),
  };
}
