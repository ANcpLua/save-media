import { describe, expect, it } from "vitest";
import type { StreamId } from "@savemedia/core";
import { createHotkeyJobs } from "../../../src/background/hotkey-jobs";

const stream = "stream-1" as StreamId;
const other = "stream-2" as StreamId;

describe("hotkey jobs", () => {
  it("turns a finished Alt+S job into a Saved toast on its tab, with the file name", () => {
    const jobs = createHotkeyJobs();
    jobs.track(stream, 7);

    expect(jobs.feedbackFor({ type: "job-complete", streamId: stream, path: "/Users/x/Downloads/clip.mp4" }))
      .toEqual({ tabId: 7, outcome: "complete", detail: "clip.mp4" });
  });

  it("turns a job the engine refused at run time into Not saved with the user-facing title", () => {
    const jobs = createHotkeyJobs();
    jobs.track(stream, 7);

    const feedback = jobs.feedbackFor({
      type: "job-failed",
      streamId: stream,
      error: { code: "cdm_required", severity: "terminal", keySystem: "com.apple.streamingkeydelivery" },
    });

    expect(feedback).toMatchObject({ tabId: 7, outcome: "failed" });
    expect(feedback?.detail).toMatch(/protected/i);
  });

  it("answers once per job, so a late duplicate message cannot toast twice", () => {
    const jobs = createHotkeyJobs();
    jobs.track(stream, 7);
    const done = { type: "job-complete", streamId: stream, path: "clip.mp4" } as const;

    expect(jobs.feedbackFor(done)).not.toBeNull();
    expect(jobs.feedbackFor(done)).toBeNull();
  });

  it("stays silent for jobs the popup started", () => {
    const jobs = createHotkeyJobs();
    jobs.track(stream, 7);

    expect(jobs.feedbackFor({ type: "job-complete", streamId: other, path: "clip.mp4" })).toBeNull();
  });

  it("ignores progress and every other message", () => {
    const jobs = createHotkeyJobs();
    jobs.track(stream, 7);

    expect(jobs.feedbackFor({ type: "descriptors", tabId: 7, descriptors: [] })).toBeNull();
    // Still tracked: an unrelated message must not consume the entry.
    expect(jobs.feedbackFor({ type: "job-complete", streamId: stream, path: "clip.mp4" })).not.toBeNull();
  });
});
