import { describe, expect, it, vi } from "vitest";
import type { StreamId } from "@savemedia/core";
import { createDiagnosticJournal, createDiagnosticsObserver, diagnosticReport, MAX_EVENTS } from "../../../src/background/save-diagnostics";
import type { BackgroundEvent } from "../../../src/background/events";
import { createSessionStore } from "../../../src/background/state/session-store";
import { readStoredState, stateKeys } from "../../../src/background/state/records";
import { httpObservation } from "../../../src/util/http-diagnostics";
import type { JobStatus } from "../../../src/types/messages";
import { directDescriptor } from "../popup/helpers/descriptors";
import { memoryArea } from "../helpers/session";

const JOB = "stream-0123456789abcdef" as StreamId;

/** A journal over a counting store, with tab 2 private, and the one observer that writes it. */
function diagnostics(generations: Record<number, number> = {}) {
  const area = memoryArea();
  const store = createSessionStore(area);
  const journal = createDiagnosticJournal(store, async tabId => tabId === 2);
  const observe = createDiagnosticsObserver(journal, tabId => generations[tabId] ?? 0, () => new Date("2026-01-02T03:04:05.000Z"));
  return { area, store, journal, observe, generations };
}

function observation(over: Record<string, unknown> = {}) {
  const request = new Headers({ range: "bytes=50-50", "if-range": '"fixture-private"', cookie: "fixture-private" });
  const response = new Headers({ "content-range": "bytes 50-50/100", "content-length": "0", etag: '"fixture-private"' });
  return { ...httpObservation("https://media.example/name?token=fixture-private", undefined, 206, key => request.get(key), key => response.get(key), 8),
    requestNumber: 1, ...over };
}

function http(tabId: number, over: Record<string, unknown> = {}, generation = 0): BackgroundEvent {
  return { type: "http", tabId, generation, source: "transfer", streamId: JOB, observation: observation(over) as never };
}

function job(status: JobStatus, previous: JobStatus | null, tabId = 3): BackgroundEvent {
  return { type: "job", tabId, generation: 0, streamId: JOB, origin: "popup", status, previous };
}

describe("the diagnostic journal", () => {
  it("isolates tabs, excludes URL and header values, and keeps a private tab's events in memory only", async () => {
    const { area, store, journal, observe } = diagnostics();
    observe({ type: "http", tabId: 1, generation: 0, source: "transfer", streamId: JOB, observation: { ...observation(), href: "fixture-private" } as never });
    observe(http(2));
    await store.durable();
    await Promise.resolve();
    await store.durable();
    const report = diagnosticReport(journal, 1, { url: "https://page.example/hidden-title/1", version: "1.2.3", browser: "chromium" }, [
      { url: "https://media.example/private/path.m3u8?token=fixture-private", error: { code: "access_denied", severity: "terminal", phase: "manifest",
        url: "https://media.example/private/path.m3u8?token=fixture-private", httpStatus: 403, explanation: "forbidden-or-expired-url" } },
    ]);
    expect(report).toMatchObject({ schemaVersion: 2, extensionVersion: "1.2.3", browser: "chromium", pageHost: "page.example", eventLimit: MAX_EVENTS, droppedEvents: 0 });
    expect(report.events).toHaveLength(1);
    expect(report.events[0]).toMatchObject({ event: "http", job: JOB, source: "transfer", host: "media.example",
      requestRange: "bytes=50-50", status: 206, declaredBytes: 0, ifRange: "etag", hasETag: true });
    expect(report.failures).toEqual([{ host: "media.example", code: "access_denied", phase: "manifest", httpStatus: 403, explanation: "forbidden-or-expired-url" }]);
    expect(JSON.stringify(report)).not.toMatch(/fixture-private|hidden-title|private\/path/);
    // The private tab's journal exists in memory and nowhere else.
    expect(journal.read(2).events).toHaveLength(1);
    expect(Object.keys(area.data)).toEqual([stateKeys.diagnostics(1)]);
    // A restarted worker reads the stored journal back as it was.
    const restarted = diagnostics();
    restarted.journal.import(readStoredState(new Map(Object.entries(area.data))).diagnostics);
    expect(restarted.journal.read(1).events).toEqual(report.events);
    expect(restarted.journal.read(2).events).toEqual([]);
  });

  it("writes a burst of events to the store once", async () => {
    const { area, store, observe } = diagnostics();
    observe(http(1));
    await store.durable();
    await Promise.resolve();
    await store.durable();
    area.set.mockClear();
    for (let request = 2; request <= 51; request++) observe(http(1, { requestNumber: request }));
    await store.durable();
    expect(area.set).toHaveBeenCalledOnce();
    expect((area.data[stateKeys.diagnostics(1)] as { events: unknown[] }).events).toHaveLength(51);
  });

  it("keeps one line per request: the report at the end of the body replaces the one at its headers", () => {
    const { journal, observe } = diagnostics();
    observe(http(1, { requestNumber: 4 }));
    observe(http(1, { requestNumber: 5 }));
    observe(http(1, { requestNumber: 4, bodyBytes: 4096, readOutcome: "complete" }));
    const events = journal.read(1).events;
    expect(events.map(event => [event["requestNumber"], event["readOutcome"] ?? null])).toEqual([[4, "complete"], [5, null]]);
  });

  it("keeps the newest events and counts the ones it dropped", () => {
    const { journal, observe } = diagnostics();
    for (let request = 1; request <= MAX_EVENTS + 5; request++) observe(http(1, { requestNumber: request }));
    expect(journal.read(1).events).toHaveLength(MAX_EVENTS);
    expect(journal.read(1).droppedEvents).toBe(5);
  });

  it("drops what belongs to a page the tab has left, and starts over with a new document", () => {
    const d = diagnostics({ 1: 0 });
    d.observe(http(1));
    d.generations[1] = 1;
    d.observe({ type: "document", tabId: 1, generation: 1, closed: false });
    expect(d.journal.read(1).events).toEqual([]);
    // A transfer that began on the old page reports late.
    d.observe(http(1, { requestNumber: 2 }, 0));
    expect(d.journal.read(1).events).toEqual([]);
    d.observe(http(1, { requestNumber: 3 }, 1));
    expect(d.journal.read(1).events).toHaveLength(1);
    d.observe({ type: "document", tabId: 1, generation: 2, closed: true });
    expect(d.journal.read(1).events).toEqual([]);
  });

  it("logs a save's milestones and kept bytes, never every progress update", () => {
    const { journal, observe } = diagnostics();
    const starting: JobStatus = { phase: "active", stage: { kind: "starting" }, bytesWritten: 0, bytesTotal: null };
    const downloading: JobStatus = { phase: "active", stage: { kind: "downloading" }, bytesWritten: 5, bytesTotal: 10 };
    const reconnecting: JobStatus = { phase: "active", stage: { kind: "reconnecting", waitMs: 2000 }, bytesWritten: 5, bytesTotal: 10 };
    const failed: JobStatus = { phase: "failed", retained: { bytes: 5, total: 10, expiresAt: 9 },
      error: { code: "transfer_failed", severity: "terminal", reason: "resume-refused", host: "media.example", receivedBytes: 5, totalBytes: 10, httpStatus: 416 } };
    observe(job(starting, null));
    observe(job(downloading, starting));
    observe(job({ ...downloading, bytesWritten: 7 }, downloading));
    observe(job(reconnecting, downloading));
    observe(job({ ...reconnecting, bytesWritten: 6 }, reconnecting));
    observe(job(failed, reconnecting));
    const events = journal.read(3).events;
    expect(events.map(event => event["stage"])).toEqual(["starting", "reconnecting", "failed"]);
    expect(events[2]).toMatchObject({ event: "job", job: JOB, code: "transfer_failed", reason: "resume-refused", httpStatus: 416, retainedBytes: 5, retainedTotal: 10 });
  });

  it("records sources, failures, scans, file saves, resumes and local downloads from the same events everything else follows", () => {
    const { journal, observe } = diagnostics();
    const descriptor = directDescriptor({ id: JOB, source: { kind: "direct-url", url: "https://cdn.example/secret/clip.mp4?token=fixture-private", headers: {} } });
    observe({ type: "source", tabId: 4, generation: 0, descriptor });
    observe({ type: "source-failure", tabId: 4, generation: 0, failure: { url: "https://cdn.example/secret/x.m3u8",
      error: { code: "tls_certificate_rejected", severity: "terminal", phase: "manifest", browserDiagnostic: { code: "net::ERR_CERT_AUTHORITY_INVALID", host: "cdn.example", ip: "192.168.1.1", finalHost: null, redirect: null } } } });
    observe({ type: "scan", tabId: 4, generation: 0, outcome: { phase: "started" } });
    observe({ type: "scan", tabId: 4, generation: 0, outcome: { phase: "finished", result: "unreachable", reach: "needs-reload" } });
    observe({ type: "scan", tabId: 4, generation: 0, outcome: { phase: "finished", result: "scanned", publishedSources: 2, fileLink: true } });
    observe({ type: "file-save", tabId: 4, generation: 0, pageUrl: "https://page.example/secret", problem: { filename: "Private name.mov", stage: "transferring",
      error: { code: "access_denied", severity: "terminal", phase: "direct", url: "https://cdn.example/secret/clip.mov", httpStatus: 403,
        explanation: "forbidden-or-expired-url" } } });
    observe({ type: "file-save", tabId: 4, generation: 0, pageUrl: "https://page.example/secret", problem: { filename: "Private name.mov", stage: "starting", error: null } });
    observe({ type: "file-recovery", tabId: 4, generation: 0, pageUrl: "https://page.example/secret", found: true, error: null,
      progress: { stage: { kind: "resuming" }, bytesWritten: 3, bytesTotal: 9 } });
    observe({ type: "file-recovery", tabId: 4, generation: 0, pageUrl: "https://page.example/secret", found: false, progress: null,
      error: { code: "engine_job_failed", severity: "terminal", at: "direct", cause: "browser-resume", detail: "NETWORK_FAILED" } });
    observe({ type: "local-job", tabId: 4, generation: 0, origin: "popup", job: { id: "local-1", pageUrl: "https://page.example/secret", tabId: 4, phase: "failed", percent: null,
      downloadedBytes: 1, totalBytes: 2, speedBytesPerSec: null, etaSeconds: null, filename: null,
      failure: { code: "unknown", message: "ERROR: private line", httpStatus: 403 } } });
    const events = journal.read(4).events;
    expect(events.map(event => event.event)).toEqual(["source_detected", "discovery_failure", "scan_started", "scan_finished", "scan_finished",
      "file_save_failure", "file_save_failure", "interrupted_download_found", "file_recovery_failure", "local_download"]);
    expect(events[0]).toMatchObject({ host: "cdn.example", protocol: descriptor.protocol, container: descriptor.container, protected: false, job: JOB });
    // Of the server's address only its kind is recorded.
    expect(events[1]).toMatchObject({ host: "cdn.example", code: "tls_certificate_rejected", browserCode: "net::ERR_CERT_AUTHORITY_INVALID",
      browserAddressScope: "private" });
    expect(JSON.stringify(events)).not.toContain("192.168");
    expect(events[5]).toMatchObject({ code: "access_denied", httpStatus: 403, stage: "transferring" });
    expect(events[6]).toMatchObject({ code: "download_could_not_start", stage: "starting" });
    expect(events[3]).toMatchObject({ result: "unreachable", reach: "needs-reload" });
    expect(events[4]).toMatchObject({ result: "scanned", publishedSources: 2, fileLink: true });
    expect(events[8]).toMatchObject({ code: "engine_job_failed", failedAt: "direct", cause: "browser-resume" });
    expect(events[8]!.at).toBe("2026-01-02T03:04:05.000Z");
    expect(events[9]).toMatchObject({ stage: "failed", code: "unknown", httpStatus: 403, bytesWritten: 1, bytesTotal: 2 });
    expect(JSON.stringify(events)).not.toMatch(/fixture-private|secret|Private name|private line/);
  });

  it("asks once per tab whether it is private", async () => {
    const area = memoryArea();
    const store = createSessionStore(area);
    const isPrivate = vi.fn(async () => false);
    const journal = createDiagnosticJournal(store, isPrivate);
    for (let n = 0; n < 5; n++) journal.add(9, 0, { at: "t", event: "scan_started" });
    await Promise.resolve();
    await Promise.resolve();
    journal.add(9, 0, { at: "t", event: "scan_started" });
    expect(isPrivate).toHaveBeenCalledOnce();
    await store.durable();
    expect((area.data[stateKeys.diagnostics(9)] as { events: unknown[] }).events).toHaveLength(6);
  });
});
