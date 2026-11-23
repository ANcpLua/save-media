// What happens in the background, as events at its boundaries: the router
// (documents, sources, jobs), capture (probe requests), the engine channel
// (transfer requests), page scans, file saves and the local downloader.
// Observers subscribe once in index.ts: diagnostics, the toolbar, the open
// popups and the Alt+S toast. Nothing else reports to them.
import type { JobError, StreamDescriptor, StreamId } from "@savemedia/core";
import type { DiscoveryFailure, FileRecoveryProgress, FileSaveProblem, JobStatus, LocalJobView } from "../types/messages";
import type { HttpObservation } from "../util/http-diagnostics";
import type { Logger } from "../util/logger";
import type { PageReachKind } from "../util/page-reach";
import type { JobOrigin } from "./state/records";

export type { JobOrigin } from "./state/records";

export type ScanOutcome =
  | { readonly phase: "started" }
  | { readonly phase: "finished"; readonly result: "scanned"; readonly publishedSources: number | null; readonly fileLink: boolean }
  | { readonly phase: "finished"; readonly result: "unreachable"; readonly reach: PageReachKind }
  | { readonly phase: "finished"; readonly result: "error" };

/**
 * `generation` is the tab's document count when the work behind the event
 * began. An observer that records per document drops an event whose
 * generation is no longer the tab's.
 */
export type BackgroundEvent =
  | { readonly type: "document"; readonly tabId: number; readonly generation: number; readonly closed: boolean }
  | { readonly type: "source"; readonly tabId: number; readonly generation: number; readonly descriptor: StreamDescriptor }
  /** What the tab lists may have changed: rows, failures, the selection's inputs. */
  | { readonly type: "sources-changed"; readonly tabId: number }
  | { readonly type: "source-failure"; readonly tabId: number; readonly generation: number; readonly failure: DiscoveryFailure }
  | { readonly type: "http"; readonly tabId: number; readonly generation: number; readonly source: "probe" | "transfer";
      readonly streamId: StreamId | null; readonly observation: HttpObservation }
  | { readonly type: "job"; readonly tabId: number; readonly generation: number; readonly streamId: StreamId; readonly origin: JobOrigin;
      readonly status: JobStatus; readonly previous: JobStatus | null }
  | { readonly type: "scan"; readonly tabId: number; readonly generation: number; readonly outcome: ScanOutcome }
  | { readonly type: "file-save"; readonly tabId: number; readonly generation: number; readonly pageUrl: string; readonly problem: FileSaveProblem | null }
  | { readonly type: "file-recovery"; readonly tabId: number; readonly generation: number; readonly pageUrl: string;
      readonly progress: FileRecoveryProgress | null; readonly found: boolean; readonly error: JobError | null }
  | { readonly type: "local-job"; readonly tabId: number | null; readonly generation: number | null; readonly job: LocalJobView;
      readonly origin: "hotkey" | "popup" };

export interface EventHub {
  emit(event: BackgroundEvent): void;
  on(listener: (event: BackgroundEvent) => void): () => void;
}

/** Synchronous fan-out. A listener that throws is logged; the others still run. */
export function createEventHub(logger?: Logger): EventHub {
  const listeners = new Set<(event: BackgroundEvent) => void>();
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        try { listener(event); }
        catch (error) { logger?.error("event listener failed", { type: event.type, error: error instanceof Error ? error.message : String(error) }); }
      }
    },
    on(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
