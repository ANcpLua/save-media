import { describe, expect, it, vi } from "vitest";
import type { StreamId } from "@savemedia/core";
import { createHotkeyObserver, failureToast } from "../../../src/background/hotkey-jobs";
import type { BackgroundEvent } from "../../../src/background/events";
import type { JobStatus, LocalJobView } from "../../../src/types/messages";

const stream = "stream-1" as StreamId;
const active: JobStatus = { phase: "active", bytesWritten: 5, bytesTotal: 10, stage: { kind: "downloading" } };

function job(status: JobStatus, previous: JobStatus | null = active, origin: "popup" | "hotkey" = "hotkey"): BackgroundEvent {
  return { type: "job", tabId: 7, generation: 0, streamId: stream, origin, status, previous };
}

function localJob(origin: "popup" | "hotkey", fields: Partial<LocalJobView>): BackgroundEvent {
  return { type: "local-job", tabId: 7, generation: 0, origin, job: { id: "local-1", pageUrl: "https://page.example/watch", tabId: 7, phase: "complete",
    percent: null, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null, filename: null, failure: null, ...fields } };
}

describe("the Alt+S toast for a Local downloader job's end", () => {
  it("says Saved, Cancelled or Not saved for a job Alt+S started", () => {
    const notify = vi.fn();
    const observe = createHotkeyObserver(notify);
    observe(localJob("hotkey", { phase: "downloading" }));
    observe(localJob("hotkey", { phase: "complete", filename: "clip.mp4" }));
    observe(localJob("hotkey", { phase: "complete" }));
    observe(localJob("hotkey", { phase: "failed", failure: { code: "cancelled", message: "" } }));
    expect(notify.mock.calls).toEqual([[7, "complete", "clip.mp4"], [7, "complete", "To your Downloads folder"], [7, "cancelled", "Nothing was saved."]]);
  });

  it("words a failure for the page, where the popup is closed", () => {
    const notify = vi.fn();
    createHotkeyObserver(notify)(localJob("hotkey", { phase: "failed", failure: { code: "host_unavailable", message: "Specified native messaging host not found." } }));
    expect(notify).toHaveBeenCalledExactlyOnceWith(7, "failed", "Helper not reachable. Open savemedia for the install command under Local downloader.");
  });

  it("sends no toast for a job the popup started, like a save in the browser", () => {
    const notify = vi.fn();
    const observe = createHotkeyObserver(notify);
    observe(localJob("popup", { phase: "complete", filename: "clip.mp4" }));
    observe(localJob("popup", { phase: "failed", failure: { code: "network", message: "" } }));
    // A job that belongs to no tab has no page to say it on.
    observe(localJob("hotkey", { phase: "complete", tabId: null }));
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("the Alt+S toast for a save's end", () => {
  it("turns a finished Alt+S save into a Saved toast on its tab, with the file name", () => {
    const notify = vi.fn();
    createHotkeyObserver(notify)(job({ phase: "complete", savedAs: "/Users/x/Downloads/clip.mp4" }));
    expect(notify).toHaveBeenCalledExactlyOnceWith(7, "complete", "clip.mp4");
  });

  it("turns a save the engine refused at run time into Not saved with the user-facing title", () => {
    const notify = vi.fn();
    createHotkeyObserver(notify)(job({ phase: "failed", error: { code: "cdm_required", severity: "terminal", keySystem: "com.apple.streamingkeydelivery" } }));
    expect(notify).toHaveBeenCalledExactlyOnceWith(7, "failed", "Protected video");
  });

  it("says where a file went when the browser names none", () => {
    const notify = vi.fn();
    createHotkeyObserver(notify)(job({ phase: "complete" }));
    expect(notify).toHaveBeenCalledExactlyOnceWith(7, "complete", "To your Downloads folder");
  });

  it("turns the user's own cancel into a neutral Cancelled toast, never into Not saved", () => {
    const notify = vi.fn();
    const observe = createHotkeyObserver(notify);
    observe(job({ phase: "cancelled", fileName: "Talk 31.mov" }));
    observe(job({ phase: "cancelled" }));
    expect(notify.mock.calls).toEqual([[7, "cancelled", "Talk 31.mov"], [7, "cancelled", "Nothing was saved."]]);
  });

  it("says what happened and what to do, whether or not the failure has technical details", () => {
    // With details (a status and a server) and with a hint: the hint is never lost to the details.
    expect(failureToast({ code: "server_busy", severity: "terminal", phase: "direct", url: "https://cdn.example/a.mp4", httpStatus: 503 }))
      .toBe("The server is busy. Try again in a few minutes.");
    expect(failureToast({ code: "access_denied", severity: "terminal", phase: "direct", url: "https://cdn.example/a.mp4", httpStatus: 403,
      explanation: "forbidden-or-expired-url" })).toBe("The server refused access. Reload the page, start playback, then try again.");
    expect(failureToast({ code: "tls_certificate_rejected", severity: "terminal", phase: "direct",
      browserDiagnostic: { host: "cdn.example", code: "net::ERR_CERT_AUTHORITY_INVALID", ip: null, finalHost: null, redirect: null } }))
      .toBe("Secure connection not trusted. Check your network filter or security software, or the secure DNS setting in your browser's settings.");
    // No status, code or address reaches the page.
    for (const text of [failureToast({ code: "server_busy", severity: "terminal", phase: "manifest", url: "https://cdn.example/a.m3u8?token=x", httpStatus: 522 }),
      failureToast({ code: "http_error", severity: "terminal", phase: "segment", url: "https://cdn.example/s.ts", httpStatus: 500 })]) {
      expect(text).not.toMatch(/HTTP|\d{3}|cdn\.example|token|manifest|segment/);
    }
  });

  it("is sent for a save that was restored after a worker restart: the save's record names who started it", () => {
    const notify = vi.fn();
    // After a restart the save's status is "active" again, as restored; nothing was remembered in worker memory.
    createHotkeyObserver(notify)(job({ phase: "failed", error: { code: "engine_stopped", severity: "terminal", when: "restart" } },
      { phase: "active", bytesWritten: 0, bytesTotal: null, stage: { kind: "starting" } }));
    expect(notify).toHaveBeenCalledExactlyOnceWith(7, "failed", expect.stringContaining("The save stopped before it finished"));
  });

  it("answers once per save: a status that changes again after the end toasts nothing", () => {
    const notify = vi.fn();
    const observe = createHotkeyObserver(notify);
    const failed: JobStatus = { phase: "failed", error: { code: "server_busy", severity: "terminal", phase: "direct", url: "", httpStatus: 503 },
      retained: { bytes: 1, total: 2, expiresAt: 3 } };
    observe(job(failed));
    // The engine let go of the kept bytes: the failure stands, and it was already announced.
    observe(job({ phase: "failed", error: failed.error! }, failed));
    expect(notify).toHaveBeenCalledOnce();
  });

  it("stays silent for saves the popup started, for progress and for every other event", () => {
    const notify = vi.fn();
    const observe = createHotkeyObserver(notify);
    observe(job({ phase: "complete", savedAs: "clip.mp4" }, active, "popup"));
    observe(job(active, { phase: "active", stage: { kind: "starting" } }));
    observe({ type: "sources-changed", tabId: 7 });
    expect(notify).not.toHaveBeenCalled();
  });
});
