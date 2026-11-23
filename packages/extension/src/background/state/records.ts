// The records the service worker keeps in chrome.storage.session, so that a
// restart of the worker loses nothing the user can see. The browser holds
// them in memory only and clears them when it quits and when the extension
// is updated, reloaded or turned off. Access stays with the extension's own
// contexts: the session area's access level is never widened.
import type { StreamDescriptor, StreamId, UserChoice } from "@savemedia/core";
import { z } from "zod";
import { JOB_PHASES, type DiscoveryFailure, type FileRecoveryProgress, type JobStatus } from "../../types/messages";
import type { PageReachKind } from "../../util/page-reach";
import type { TabMediaState } from "../../util/tab-media-state";
import type { TabFacts } from "../../types/page-facts";

/** A schema change moves to a new prefix; keys of an older one are deleted when a worker starts. */
export const STATE_PREFIX = "sm1:";

export const stateKeys = {
  tab: (tabId: number) => `sm1:tab:${tabId}`,
  descriptor: (tabId: number, id: string) => `sm1:desc:${tabId}:${id}`,
  covered: (tabId: number) => `sm1:cov:${tabId}`,
  media: (tabId: number) => `sm1:media:${tabId}`,
  origins: (tabId: number) => `sm1:origins:${tabId}`,
  received: (tabId: number) => `sm1:received:${tabId}`,
  /** Which of the tab's streams the page requested last, and on which route. */
  activity: (tabId: number) => `sm1:activity:${tabId}`,
  /** What the tab's frames last reported about their media elements, without thumbnails. */
  facts: (tabId: number) => `sm1:facts:${tabId}`,
  diagnostics: (tabId: number) => `sm1:diag:${tabId}`,
  /** Tabs this worker saw start loading a document: their content script was injected. */
  loaded: "sm1:loaded",
  jobs: "sm1:jobs",
  prompts: "sm1:prompts",
  recoveries: "sm1:recov",
  /** Tabs whose toolbar icon or title savemedia changed. */
  toolbar: "sm1:toolbar",
  /** The notices on tabs' toolbar buttons: each stays until its tab shows another page. */
  notices: "sm1:notices",
  /** The Referer rules savemedia holds in the browser. */
  rules: "sm1:rules",
} as const;

/** The per-tab key kinds, for deleting everything of a closed tab. */
export const TAB_KEY_KINDS = ["tab", "cov", "media", "origins", "received", "activity", "facts", "diag"] as const;

export type JobOrigin = "popup" | "hotkey";
export type JobPhase = "starting" | "engine" | "writing";
export type PlanKind = "direct" | "hls-plain" | "av-merge";

export interface PermitData { readonly receiptKey: string; readonly resumeKey: string | null }

export interface TabRecord {
  readonly v: 1;
  readonly tabId: number;
  /** One more for every new top document of the tab. */
  readonly generation: number;
  /** The descriptor order: key and id of each row. */
  readonly order: readonly { readonly key: string; readonly id: string }[];
  readonly indexedPlaylists: readonly string[];
  readonly failures: readonly DiscoveryFailure[];
  readonly lastNamedStream: string | null;
  /** Finished saves of this tab's rows. Running ones are in the job records. */
  readonly statuses: Readonly<Record<string, JobStatus>>;
  /** Stream id to the resume scope of a status that promises kept bytes. */
  readonly retainedBy: Readonly<Record<string, string>>;
  readonly reach: PageReachKind | null;
  /** For choosing what to drop when the store is full. Never a decision input. */
  readonly touchedAt: number;
}

export interface JobRecord {
  readonly v: 1;
  readonly streamId: StreamId;
  readonly tabId: number;
  readonly generation: number;
  readonly origin: JobOrigin;
  readonly descriptor: StreamDescriptor;
  readonly choice: UserChoice;
  readonly fileName: string | null;
  readonly planKind: PlanKind | null;
  /** The page whose Referer the job's requests send. Null or absent: the tab's page. */
  readonly referrer?: string | null;
  readonly permit: PermitData | null;
  readonly phase: JobPhase;
  readonly output: { readonly blobUrl: string; readonly filename: string; readonly downloadId: number | null } | null;
}

/** What to start again when the user allows a repeated save after the worker restarted. */
export type ConfirmRequest =
  | { readonly kind: "stream"; readonly streamId: StreamId; readonly choice: UserChoice;
      readonly file: { readonly pageUrl: string; readonly filename: string } | null; readonly origin: JobOrigin }
  | { readonly kind: "page"; readonly tabId: number; readonly pageUrl: string }
  /**
   * An image saved with Alt+S. `image` is null when its address is too long to keep in a record, as an
   * image written into the page (data:) can be: then the press is asked for again instead.
   */
  | { readonly kind: "image"; readonly tabId: number; readonly pageUrl: string;
      readonly image: { readonly url: string; readonly pageUrl: string; readonly loaded: boolean } | null };

export interface PromptRecord {
  readonly v: 1;
  readonly id: string;
  readonly tabId: number;
  readonly pageUrl: string;
  readonly filename: string;
  readonly receiptKey: string;
  readonly request: ConfirmRequest;
}

export interface RecoveryRecord {
  readonly v: 1;
  readonly tabId: number;
  readonly pageUrl: string;
  readonly filename: string;
  readonly downloadId: number;
  readonly receiptKey: string;
  readonly generation: number;
  readonly progress: FileRecoveryProgress | null;
}

export type DiagnosticEvent = { readonly at: string; readonly event: string; readonly job?: string }
  & Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface DiagnosticsRecord {
  readonly v: 1;
  readonly generation: number;
  readonly events: readonly DiagnosticEvent[];
  readonly droppedEvents: number;
}

/** A Referer rule in the browser and who needs it. */
export interface RuleRecord {
  readonly id: number;
  readonly host: string;
  readonly referer: string;
  /** Jobs whose requests depend on the rule. A held rule is never switched or dropped. */
  readonly holders: readonly string[];
}

/**
 * The stored parts of a tab's media state. Owners are indexed again from the
 * rows. Activity and the last facts are stored too: what a tab lists depends
 * on them, and it must not change because the worker restarted.
 */
export type ActivityRecord = TabMediaState["activity"];
export type MediaRecord = Pick<TabMediaState, "topDocument" | "frames" | "ads" | "assetLists" | "timelines" | "elementDrm">
  & Partial<Pick<TabMediaState, "loadFailed">>;
export type OriginsRecord = TabMediaState["origins"];
export interface ReceivedRecord { readonly received: TabMediaState["received"]; readonly earlier: TabMediaState["earlier"];
  readonly localOrigins?: TabMediaState["localOrigins"]; readonly fetched?: TabMediaState["fetched"] }

// Validation is shallow on purpose: these values were written by this
// extension version (the prefix names the schema), and only its own contexts
// can write them. The checks catch a truncated or foreign value.
const object = z.looseObject({});
const tabId = z.number().int();
const text = z.string();
const jobStatus = z.looseObject({ phase: z.enum(JOB_PHASES) });

const tabRecord = z.object({
  v: z.literal(1), tabId, generation: z.number().int().min(0),
  order: z.array(z.object({ key: text, id: text })),
  indexedPlaylists: z.array(text),
  failures: z.array(z.object({ url: text, error: object })),
  lastNamedStream: text.nullable(),
  statuses: z.record(text, jobStatus),
  retainedBy: z.record(text, text),
  reach: text.nullable(),
  touchedAt: z.number(),
});
const descriptorRecord = z.looseObject({ id: text, tabId, pageUrl: text, source: z.looseObject({ kind: text }), protocol: text, variants: z.array(z.unknown()) });
const jobRecord = z.object({
  v: z.literal(1), streamId: text, tabId, generation: z.number().int(), origin: z.enum(["popup", "hotkey"]),
  descriptor: descriptorRecord, choice: object, fileName: text.nullable(), planKind: z.enum(["direct", "hls-plain", "av-merge"]).nullable(),
  referrer: text.nullable().optional(),
  permit: z.object({ receiptKey: text, resumeKey: text.nullable() }).nullable(),
  phase: z.enum(["starting", "engine", "writing"]),
  output: z.object({ blobUrl: text, filename: text, downloadId: z.number().int().nullable() }).nullable(),
});
const promptRecord = z.object({ v: z.literal(1), id: text, tabId, pageUrl: text, filename: text, receiptKey: text,
  request: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("stream"), streamId: text, choice: object, file: z.object({ pageUrl: text, filename: text }).nullable(),
      origin: z.enum(["popup", "hotkey"]) }),
    z.object({ kind: z.literal("page"), tabId, pageUrl: text }),
    z.object({ kind: z.literal("image"), tabId, pageUrl: text,
      image: z.object({ url: text, pageUrl: text, loaded: z.boolean() }).nullable() }),
  ]) });
const recoveryRecord = z.object({ v: z.literal(1), tabId, pageUrl: text, filename: text, downloadId: z.number().int(), receiptKey: text,
  generation: z.number().int(), progress: object.nullable() });
const diagnosticsRecord = z.object({ v: z.literal(1), generation: z.number().int(), events: z.array(z.looseObject({ at: text, event: text })),
  droppedEvents: z.number().int().min(0) });
const ruleRecord = z.object({ id: z.number().int().min(1), host: text, referer: text, holders: z.array(text) });
const mediaRecord = z.object({ topDocument: text.nullable(), loadFailed: z.boolean().optional(), frames: z.record(text, object), ads: z.record(text, text), assetLists: z.array(text),
  timelines: z.record(text, object), elementDrm: z.record(text, object) });
const activityRecord = z.record(text, z.object({ at: z.number(), frameId: z.number().int(), generation: z.number().int() }));
const factsRecord = z.object({ reachable: z.boolean(),
  frames: z.array(z.looseObject({ frameId: z.number().int(), url: text, top: z.boolean(), elements: z.array(object), pageGroups: z.array(object) })) });
const localOriginsRecord = z.record(text, z.literal(true));
const fetchedRecord = z.record(text, z.object({ frameId: z.number().int(), documentId: text.nullable(), ip: text.nullable() }));
const receivedRecord = z.object({ received: z.record(text, object), localOrigins: localOriginsRecord.optional(), fetched: fetchedRecord.optional(),
  earlier: z.array(z.object({ documentId: text, received: z.record(text, object), localOrigins: localOriginsRecord.optional(), fetched: fetchedRecord.optional() })) });

export interface StoredState {
  readonly tabs: Map<number, TabRecord>;
  readonly descriptors: Map<number, Map<string, StreamDescriptor>>;
  readonly covered: Map<number, readonly string[]>;
  readonly media: Map<number, MediaRecord>;
  readonly origins: Map<number, OriginsRecord>;
  readonly received: Map<number, ReceivedRecord>;
  readonly activity: Map<number, ActivityRecord>;
  readonly facts: Map<number, TabFacts>;
  readonly diagnostics: Map<number, DiagnosticsRecord>;
  loaded: readonly number[];
  jobs: readonly JobRecord[];
  prompts: readonly PromptRecord[];
  recoveries: readonly RecoveryRecord[];
  toolbar: readonly number[];
  notices: readonly { readonly tabId: number; readonly title: string }[];
  rules: readonly RuleRecord[];
  /** Keys that are not this version's, or whose value is not what its key promises. */
  readonly invalid: string[];
}

function parsed<T>(schema: z.ZodType, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? value as T : null;
}

function list<T>(schema: z.ZodType, value: unknown): readonly T[] | null {
  return parsed<readonly T[]>(z.array(schema), value);
}

/** Sort stored entries (already decoded with fromWire) into typed records. Receipts are read on demand and pass through. */
export function readStoredState(entries: ReadonlyMap<string, unknown>): StoredState {
  const state: StoredState = { tabs: new Map(), descriptors: new Map(), covered: new Map(), media: new Map(), origins: new Map(),
    received: new Map(), activity: new Map(), facts: new Map(), diagnostics: new Map(), loaded: [], jobs: [], prompts: [], recoveries: [], toolbar: [], notices: [], rules: [], invalid: [] };
  const numbers = z.array(tabId);
  for (const [key, value] of entries) {
    if (!key.startsWith(STATE_PREFIX)) {
      // Keys of earlier versions of this state. Other keys are not this module's.
      if (/^sm\d+:/.test(key) || key.startsWith("save-diagnostics-v1-")) state.invalid.push(key);
      continue;
    }
    const [, kind, tab, ...rest] = key.split(":");
    const id = Number(tab);
    let ok = false;
    if (key === stateKeys.loaded) { const v = parsed<number[]>(numbers, value); if (v) { state.loaded = v; ok = true; } }
    else if (key === stateKeys.toolbar) { const v = parsed<number[]>(numbers, value); if (v) { state.toolbar = v; ok = true; } }
    else if (key === stateKeys.jobs) { const v = list<JobRecord>(jobRecord, value); if (v) { state.jobs = v; ok = true; } }
    else if (key === stateKeys.prompts) { const v = list<PromptRecord>(promptRecord, value); if (v) { state.prompts = v; ok = true; } }
    else if (key === stateKeys.recoveries) { const v = list<RecoveryRecord>(recoveryRecord, value); if (v) { state.recoveries = v; ok = true; } }
    else if (key === stateKeys.notices) {
      const v = list<{ tabId: number; title: string }>(z.object({ tabId, title: text }), value);
      if (v) { state.notices = v; ok = true; }
    }
    else if (key === stateKeys.rules) { const v = list<RuleRecord>(ruleRecord, value); if (v) { state.rules = v; ok = true; } }
    else if (kind === "saved") ok = value === true;
    else if (!Number.isInteger(id)) ok = false;
    else if (kind === "tab") { const v = parsed<TabRecord>(tabRecord, value); if (v && v.tabId === id) { state.tabs.set(id, v); ok = true; } }
    else if (kind === "desc") {
      const v = parsed<StreamDescriptor>(descriptorRecord, value);
      if (v && v.id === rest.join(":")) { (state.descriptors.get(id) ?? state.descriptors.set(id, new Map()).get(id)!).set(v.id, v); ok = true; }
    }
    else if (kind === "cov") { const v = parsed<string[]>(z.array(text), value); if (v) { state.covered.set(id, v); ok = true; } }
    else if (kind === "media") { const v = parsed<MediaRecord>(mediaRecord, value); if (v) { state.media.set(id, v); ok = true; } }
    else if (kind === "origins") { const v = parsed<OriginsRecord>(z.record(text, object), value); if (v) { state.origins.set(id, v); ok = true; } }
    else if (kind === "received") { const v = parsed<ReceivedRecord>(receivedRecord, value); if (v) { state.received.set(id, v); ok = true; } }
    else if (kind === "activity") { const v = parsed<ActivityRecord>(activityRecord, value); if (v) { state.activity.set(id, v); ok = true; } }
    else if (kind === "facts") { const v = parsed<TabFacts>(factsRecord, value); if (v) { state.facts.set(id, v); ok = true; } }
    else if (kind === "diag") { const v = parsed<DiagnosticsRecord>(diagnosticsRecord, value); if (v) { state.diagnostics.set(id, v); ok = true; } }
    if (!ok) state.invalid.push(key);
  }
  return state;
}

/** Every key of the stored entries that belongs to one of these tabs. */
export function keysOfTabs(entries: Iterable<string>, tabs: ReadonlySet<number>): string[] {
  const keys: string[] = [];
  for (const key of entries) {
    const [prefix, kind, tab] = key.split(":");
    if (prefix + ":" !== STATE_PREFIX || !kind || tab === undefined) continue;
    if ((kind === "desc" || (TAB_KEY_KINDS as readonly string[]).includes(kind)) && tabs.has(Number(tab))) keys.push(key);
  }
  return keys;
}
