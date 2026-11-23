// The diagnostic export: a short journal of what savemedia saw and did on a
// tab's current page, without addresses, paths, titles or file names. One
// observer writes it from the background's events; nothing else reports to it.
import { errorFacts, type ErrorFacts } from "@savemedia/core";
import { sourceAddress } from "../util/media-address";
import type { DiscoveryFailure, JobStatus } from "../types/messages";
import type { TransferStage } from "../types/transfer";
import { diagnosticHost, httpObservationSchema } from "../util/http-diagnostics";
import type { BackgroundEvent } from "./events";
import type { SessionStore } from "./state/session-store";
import { stateKeys, type DiagnosticEvent, type DiagnosticsRecord } from "./state/records";

type Fields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export const MAX_EVENTS = 128;
/** Only ids savemedia derives itself are exported; they name nothing of the page. */
const JOB_ID = /^stream-[0-9a-f]{16}(?:-\d+)?$/;

export interface DiagnosticJournal {
  /** `replaces`: an earlier entry this one supersedes (a request's headers report, once its body ended). */
  add(tabId: number, generation: number, entry: DiagnosticEvent, replaces?: (earlier: DiagnosticEvent) => boolean): void;
  /** A new document: the journal starts over. */
  reset(tabId: number, generation: number): void;
  forget(tabId: number): void;
  import(records: ReadonlyMap<number, DiagnosticsRecord>): void;
  read(tabId: number): { readonly events: readonly DiagnosticEvent[]; readonly droppedEvents: number };
  /** Tabs with a stored journal, least recently written first. */
  storedTabs(): readonly number[];
}

/**
 * Memory is the journal; the store is its copy for a worker restart. A
 * private tab's journal is never stored. Whether a tab is private is asked
 * once per tab, and entries added before the answer are stored with the
 * first write after it.
 */
export function createDiagnosticJournal(store: SessionStore, isPrivate: (tabId: number) => Promise<boolean>): DiagnosticJournal {
  interface Journal { generation: number; events: DiagnosticEvent[]; droppedEvents: number; storable: boolean | null }
  const journals = new Map<number, Journal>();
  const privacy = new Map<number, Promise<void>>();

  function write(tabId: number, journal: Journal): void {
    if (journal.storable) {
      // Rewritten keys move to the end: the map's order is the write order.
      journals.delete(tabId);
      journals.set(tabId, journal);
      store.put(stateKeys.diagnostics(tabId), { v: 1, generation: journal.generation, events: journal.events,
        droppedEvents: journal.droppedEvents } satisfies DiagnosticsRecord);
      return;
    }
    if (journal.storable !== null || privacy.has(tabId)) return;
    privacy.set(tabId, isPrivate(tabId).then(value => !value, () => false).then(storable => {
      privacy.delete(tabId);
      const current = journals.get(tabId);
      if (!current) return;
      current.storable = storable;
      if (storable) write(tabId, current);
    }));
  }

  function journalOf(tabId: number, generation: number): Journal {
    let journal = journals.get(tabId);
    if (!journal) {
      journal = { generation, events: [], droppedEvents: 0, storable: null };
      journals.set(tabId, journal);
    } else if (journal.generation !== generation) {
      journal.generation = generation;
      journal.events = [];
      journal.droppedEvents = 0;
    }
    return journal;
  }

  return {
    add(tabId, generation, entry, replaces) {
      const journal = journalOf(tabId, generation);
      const from = Math.max(0, journal.events.length - 16);
      let at = -1;
      if (replaces) for (let index = journal.events.length - 1; index >= from && at < 0; index--) if (replaces(journal.events[index]!)) at = index;
      if (at >= 0) journal.events[at] = entry;
      else {
        journal.events.push(entry);
        if (journal.events.length > MAX_EVENTS) {
          journal.events.shift();
          journal.droppedEvents++;
        }
      }
      write(tabId, journal);
    },
    reset(tabId, generation) {
      const journal = journals.get(tabId);
      if (!journal) return;
      journal.generation = generation;
      journal.events = [];
      journal.droppedEvents = 0;
      if (journal.storable) store.delete(stateKeys.diagnostics(tabId));
    },
    forget(tabId) {
      if (journals.delete(tabId)) store.delete(stateKeys.diagnostics(tabId));
    },
    import(records) {
      // Only journals of tabs that were not private were stored.
      for (const [tabId, record] of records) {
        journals.set(tabId, { generation: record.generation, events: [...record.events], droppedEvents: record.droppedEvents, storable: true });
      }
    },
    read(tabId) {
      const journal = journals.get(tabId);
      return { events: journal?.events.slice() ?? [], droppedEvents: journal?.droppedEvents ?? 0 };
    },
    storedTabs: () => [...journals].filter(([, journal]) => journal.storable).map(([tabId]) => tabId),
  };
}

/** An error's exportable facts. Its `at` (the step that failed) is named `failedAt`: an entry's `at` is its time. */
function failureFacts(error: Parameters<typeof errorFacts>[0]): ErrorFacts {
  const { at, ...facts } = errorFacts(error);
  return at === undefined ? facts : { ...facts, failedAt: at };
}

/** The stage kinds worth a line. Byte progress within a stage is not. */
const MILESTONES: ReadonlySet<TransferStage["kind"]> = new Set(["starting", "probing", "retrying", "reconnecting", "resuming", "rechecking",
  "restarting", "verifying", "finalizing", "writing"]);

function milestone(status: JobStatus | null): string | null {
  if (!status) return null;
  if (status.phase !== "active") return status.phase;
  return status.stage && MILESTONES.has(status.stage.kind) ? status.stage.kind : null;
}

function jobFields(status: JobStatus): Fields {
  const stage = status.stage;
  return {
    stage: milestone(status), bytesWritten: status.bytesWritten ?? null, bytesTotal: status.bytesTotal ?? null,
    ...(stage?.kind === "retrying" ? { attempt: stage.attempt, maxAttempts: stage.maxAttempts, httpStatus: stage.httpStatus ?? null } : {}),
    ...(stage?.kind === "restarting" ? { cause: stage.cause } : {}),
    ...(status.error ? failureFacts(status.error) : {}),
    ...(status.retained ? { retainedBytes: status.retained.bytes, retainedTotal: status.retained.total } : {}),
  };
}

/**
 * The one writer of the journal. An event that began under another document
 * count than the tab has now belongs to a page that is gone, and is dropped.
 */
export function createDiagnosticsObserver(journal: DiagnosticJournal, generation: (tabId: number) => number,
  now: () => Date = () => new Date()): (event: BackgroundEvent) => void {
  function add(tabId: number, eventGeneration: number, event: string, fields: Fields, job?: string | null,
    replaces?: (earlier: DiagnosticEvent) => boolean): void {
    if (eventGeneration !== generation(tabId)) return;
    journal.add(tabId, eventGeneration, { ...fields, at: now().toISOString(), event, ...(job && JOB_ID.test(job) ? { job } : {}) }, replaces);
  }
  return event => {
    switch (event.type) {
      case "document":
        if (event.closed) journal.forget(event.tabId);
        else journal.reset(event.tabId, event.generation);
        return;
      case "source":
        add(event.tabId, event.generation, "source_detected", { host: diagnosticHost(sourceAddress(event.descriptor)), protocol: event.descriptor.protocol,
          container: event.descriptor.container, protected: !!event.descriptor.drm }, event.descriptor.id);
        return;
      case "source-failure":
        add(event.tabId, event.generation, "discovery_failure", { host: diagnosticHost(event.failure.url), ...failureFacts(event.failure.error) });
        return;
      case "http": {
        const observation = httpObservationSchema.safeParse(event.observation);
        if (!observation.success) return;
        const { requestNumber } = observation.data;
        // A request reports when its headers arrive and again when its body ended: one line per request.
        const sameRequest = observation.data.readOutcome === undefined || requestNumber === undefined ? undefined
          : (earlier: DiagnosticEvent): boolean => earlier.event === "http" && earlier["source"] === event.source
            && earlier["requestNumber"] === requestNumber && earlier["host"] === observation.data.host && earlier["readOutcome"] === undefined
            && (earlier.job ?? null) === (event.streamId && JOB_ID.test(event.streamId) ? event.streamId : null);
        add(event.tabId, event.generation, "http", { source: event.source, ...observation.data }, event.streamId, sameRequest);
        return;
      }
      case "job":
        if (milestone(event.status) === null || milestone(event.status) === milestone(event.previous)) return;
        add(event.tabId, event.generation, "job", jobFields(event.status), event.streamId);
        return;
      case "scan": {
        const outcome = event.outcome;
        if (outcome.phase === "started") add(event.tabId, event.generation, "scan_started", {});
        else add(event.tabId, event.generation, "scan_finished", { result: outcome.result,
          ...(outcome.result === "unreachable" ? { reach: outcome.reach } : {}),
          ...(outcome.result === "scanned" ? { publishedSources: outcome.publishedSources, fileLink: outcome.fileLink } : {}) });
        return;
      }
      case "file-save":
        if (event.problem) add(event.tabId, event.generation, "file_save_failure",
          { ...(event.problem.error ? failureFacts(event.problem.error) : { code: "download_could_not_start" }), stage: event.problem.stage });
        return;
      case "file-recovery":
        if (event.found && event.progress) add(event.tabId, event.generation, "interrupted_download_found",
          { bytesWritten: event.progress.bytesWritten, bytesTotal: event.progress.bytesTotal });
        if (event.error) add(event.tabId, event.generation, "file_recovery_failure", failureFacts(event.error));
        return;
      case "local-job": {
        const job = event.job;
        if (event.tabId === null || event.generation === null || (job.phase !== "complete" && job.phase !== "failed")) return;
        add(event.tabId, event.generation, "local_download", { stage: job.phase, code: job.failure?.code ?? null,
          httpStatus: job.failure?.httpStatus ?? null, bytesWritten: job.downloadedBytes ?? null, bytesTotal: job.totalBytes ?? null });
        return;
      }
      default:
        return;
    }
  };
}

export interface DiagnosticReport {
  readonly schemaVersion: 2;
  readonly extensionVersion: string;
  readonly browser: string;
  readonly exportedAt: string;
  readonly pageHost: string;
  readonly eventLimit: number;
  readonly droppedEvents: number;
  readonly events: readonly DiagnosticEvent[];
  readonly failures: readonly ({ readonly host: string } & ErrorFacts)[];
}

/** The export file's content. */
export function diagnosticReport(journal: DiagnosticJournal, tabId: number, page: { readonly url: string; readonly version: string; readonly browser: string },
  failures: readonly DiscoveryFailure[], now: Date = new Date()): DiagnosticReport {
  return { schemaVersion: 2, extensionVersion: page.version, browser: page.browser, exportedAt: now.toISOString(),
    pageHost: diagnosticHost(page.url), eventLimit: MAX_EVENTS, ...journal.read(tabId),
    failures: failures.map(failure => ({ host: diagnosticHost(failure.url), ...failureFacts(failure.error) })) };
}
