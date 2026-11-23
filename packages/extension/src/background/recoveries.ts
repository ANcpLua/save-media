// Chrome's own resume of an interrupted download, as a record: which
// download, for which page and file, under which receipt. A worker restart
// during the resume keeps waiting for the same download, writes the receipt
// when it completes and reports when it does not.
import { isJobError, type JobError } from "@savemedia/core";
import type { FileRecoveryProgress } from "../types/messages";
import type { DownloadWatch } from "./download-watch";
import type { EventHub } from "./events";
import type { SavePermit, PermitData } from "./session-saves";
import type { SessionStore } from "./state/session-store";
import { stateKeys, type RecoveryRecord } from "./state/records";

export interface RecoveriesDeps {
  readonly store: SessionStore;
  readonly events: EventHub;
  readonly watch: Pick<DownloadWatch, "wait">;
  readonly generation: (tabId: number) => number;
  readonly permitFrom: (data: PermitData) => SavePermit;
  /** Looks at a download the browser finished resuming: why it is not kept, when it is not the video. */
  readonly settle?: (downloadId: number) => Promise<JobError | null>;
}

export interface Recoveries {
  /** The resume's progress as it is reported; null ends it. `error` is why it failed, when it did. */
  update(tabId: number, pageUrl: string, progress: FileRecoveryProgress | null, error?: JobError): void;
  /** Chrome accepted the resume: from here on a restarted worker can pick it up. */
  started(tabId: number, pageUrl: string, filename: string, downloadId: number, receiptKey: string): void;
  current(tabId: number, pageUrl: string): FileRecoveryProgress | null;
  /** Receipts the running resumes hold. */
  receipts(): readonly string[];
  forgetTab(tabId: number): void;
  import(records: readonly RecoveryRecord[]): void;
  /** After a worker restart: wait for the stored downloads to end. */
  resume(): Promise<void>;
}

export function createRecoveries(deps: RecoveriesDeps): Recoveries {
  /** One per tab: a tab shows one page. A resume that has not started in Chrome yet has no download id. */
  const records = new Map<number, Omit<RecoveryRecord, "downloadId" | "receiptKey"> & { downloadId: number | null; receiptKey: string | null }>();
  const save = (): void => deps.store.put(stateKeys.recoveries,
    [...records.values()].filter((record): record is RecoveryRecord => record.downloadId !== null && record.receiptKey !== null));

  function end(tabId: number, pageUrl: string, error: JobError | null): void {
    const record = records.get(tabId);
    if (record?.pageUrl !== pageUrl) return;
    records.delete(tabId);
    save();
    deps.events.emit({ type: "file-recovery", tabId, generation: record.generation, pageUrl, progress: null, found: false, error });
  }

  const update: Recoveries["update"] = (tabId, pageUrl, progress, error) => {
    if (!progress) { end(tabId, pageUrl, error ?? null); return; }
    const known = records.get(tabId);
    const found = known?.pageUrl !== pageUrl;
    const record = found ? { v: 1 as const, tabId, pageUrl, filename: "", downloadId: null, receiptKey: null, generation: deps.generation(tabId), progress }
      : { ...known!, progress };
    records.set(tabId, record);
    if (record.downloadId !== null) save();
    deps.events.emit({ type: "file-recovery", tabId, generation: record.generation, pageUrl, progress, found, error: null });
  };

  return {
    update,
    started(tabId, pageUrl, filename, downloadId, receiptKey) {
      const known = records.get(tabId);
      records.set(tabId, { v: 1, tabId, pageUrl, filename, downloadId, receiptKey,
        generation: known?.pageUrl === pageUrl ? known.generation : deps.generation(tabId), progress: known?.pageUrl === pageUrl ? known.progress : null });
      save();
    },
    current(tabId, pageUrl) {
      const record = records.get(tabId);
      return record?.pageUrl === pageUrl ? record.progress : null;
    },
    receipts: () => [...records.values()].flatMap(record => record.receiptKey ? [record.receiptKey] : []),
    forgetTab(tabId) {
      // The download goes on in the browser; only the tab's view of it ends.
      if (records.delete(tabId)) save();
    },
    import(stored) {
      for (const record of stored) records.set(record.tabId, { ...record });
    },
    async resume() {
      await Promise.all([...records.values()].map(async record => {
        if (record.downloadId === null || record.receiptKey === null) return;
        const permit = deps.permitFrom({ receiptKey: record.receiptKey, resumeKey: null });
        try {
          // The browser reports the bytes of its resume as the first worker showed them.
          await deps.watch.wait(record.downloadId, item => {
            // Only while the tab still shows the page the resume belongs to.
            if (records.get(record.tabId)?.downloadId !== record.downloadId) return;
            update(record.tabId, record.pageUrl, { stage: { kind: "resuming" }, bytesWritten: item.bytesReceived,
              bytesTotal: item.totalBytes > 0 ? item.totalBytes : null });
          });
          const refused = await deps.settle?.(record.downloadId) ?? null;
          if (refused) throw refused;
          await permit.finish(true);
          end(record.tabId, record.pageUrl, null);
        } catch (failure) {
          await permit.finish(false);
          const error: JobError = isJobError(failure) ? failure
            : { code: "engine_job_failed", severity: "terminal", at: "direct", cause: "browser-resume", detail: "" };
          end(record.tabId, record.pageUrl, error);
          deps.events.emit({ type: "file-save", tabId: record.tabId, generation: record.generation, pageUrl: record.pageUrl,
            problem: { filename: record.filename, stage: "transferring", error } });
        }
      }));
    },
  };
}
