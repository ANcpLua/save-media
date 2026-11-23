import { describe, expect, it } from "vitest";
import { describeTransfer, retainedMinutes } from "../../../src/util/transfer-progress";
import type { TransferStage } from "../../../src/types/transfer";

const view = (stage: TransferStage, bytesWritten?: number, bytesTotal?: number | null) =>
  describeTransfer({ stage, ...(bytesWritten === undefined ? {} : { bytesWritten }), ...(bytesTotal === undefined ? {} : { bytesTotal }) });

describe("describeTransfer", () => {
  it("writes plain labels from stages, never codes or raw counts", () => {
    expect(view({ kind: "segment", index: 12, count: 300 }, 1000, null)).toEqual({ label: "Downloading", percent: 4, bytesText: "1000 B received",
      retrying: false, cancellable: true, announce: null, waiting: false });
    expect(view({ kind: "retrying", attempt: 2, maxAttempts: 3, waitMs: 4000, httpStatus: 503, part: { index: 2, count: 4 } }, 10, 100))
      .toEqual({ label: "The server is busy, trying again in 4 seconds", percent: 10, bytesText: "10 B of 100 B", retrying: true, cancellable: true,
        announce: "The server is busy, trying again", waiting: true });
    expect(view({ kind: "retrying", attempt: 2, maxAttempts: 12, waitMs: 150, httpStatus: null, part: null }).label).toBe("Connection interrupted, trying again in 1 second");
    expect(view({ kind: "reconnecting", waitMs: 1000 }).label).toBe("Connection lost, resuming in 1 second");
    expect(view({ kind: "restarting", cause: "retained-rejected" })).toMatchObject({ label: "The saved part no longer matches, starting over", retrying: true });
    expect(view({ kind: "writing" })).toEqual({ label: "Saving to Downloads", percent: undefined, bytesText: null, retrying: false, cancellable: false,
      announce: "Saving to Downloads", waiting: false });
    expect(describeTransfer({}).label).toBe("Starting");
  });

  it("has a label for every stage, without part counts, codes, statuses or protocol words", () => {
    const stages: TransferStage[] = [
      { kind: "starting" }, { kind: "probing" }, { kind: "playlist" }, { kind: "downloading" }, { kind: "segment", index: 75, count: 100 },
      { kind: "track", track: "video" }, { kind: "track", track: "audio" },
      { kind: "retrying", attempt: 1, maxAttempts: 5, waitMs: 2000, httpStatus: 503, part: null }, { kind: "reconnecting", waitMs: 3000 },
      { kind: "resuming" }, { kind: "rechecking" }, { kind: "restarting", cause: "ranges-unusable" }, { kind: "remuxing", fraction: 0.5 },
      { kind: "merging", fraction: null }, { kind: "verifying" }, { kind: "finalizing" }, { kind: "writing" },
    ];
    expect(stages.map(stage => view(stage).label)).toEqual([
      "Starting", "Checking the file", "Reading the playlist", "Downloading", "Downloading", "Downloading video", "Downloading audio",
      "The server is busy, trying again in 2 seconds", "Connection lost, resuming in 3 seconds", "Resuming the download",
      "Checking the part saved earlier", "Starting the download over", "Converting to MP4", "Joining video and audio",
      "Checking the finished file", "Preparing the file", "Saving to Downloads",
    ]);
    for (const stage of stages) {
      const { label, announce } = view(stage);
      expect(`${label} ${announce ?? ""}`).not.toMatch(/\d+\/\d+|segment|HTTP|503|remux|manifest|SaveMedia|[\u2013\u2014]|\.\.\./i);
    }
  });

  it("counts a wait down from the moment its stage began, and stops at the plain label", () => {
    const wait = (now: number) => describeTransfer({ stage: { kind: "reconnecting", waitMs: 5000 }, stageSince: 10_000 }, now);
    expect(wait(10_000)).toMatchObject({ label: "Connection lost, resuming in 5 seconds", waiting: true });
    expect(wait(13_200)).toMatchObject({ label: "Connection lost, resuming in 2 seconds", waiting: true });
    expect(wait(14_999)).toMatchObject({ label: "Connection lost, resuming in 1 second", waiting: true });
    expect(wait(15_000)).toMatchObject({ label: "Connection lost, resuming", waiting: false });
    expect(wait(60_000)).toMatchObject({ label: "Connection lost, resuming", waiting: false });
    // What is said aloud never counts.
    expect(wait(13_200).announce).toBe("Connection lost, resuming");
  });

  it("states bytes as received of a total when the total is known, and as received otherwise", () => {
    expect(view({ kind: "downloading" }, 540 * 1024 ** 2, 1.2 * 1024 ** 3).bytesText).toBe("540.0 MB of 1.20 GB");
    expect(view({ kind: "downloading" }, 540 * 1024 ** 2, null).bytesText).toBe("540.0 MB received");
    expect(view({ kind: "downloading" }).bytesText).toBeNull();
    expect(view({ kind: "verifying" }, 5, 10).bytesText).toBeNull();
  });

  it("says aloud only the stages worth hearing, and lets a save be cancelled until its file is being put together", () => {
    const said = (stage: TransferStage) => view(stage).announce;
    for (const quiet of [{ kind: "starting" }, { kind: "probing" }, { kind: "playlist" }, { kind: "downloading" }, { kind: "segment", index: 1, count: 2 },
      { kind: "track", track: "video" }, { kind: "rechecking" }, { kind: "finalizing" }] as TransferStage[]) expect(said(quiet)).toBeNull();
    expect(said({ kind: "merging", fraction: 0.2 })).toBe("Joining video and audio");
    expect(said({ kind: "verifying" })).toBe("Checking the finished file");
    expect(view({ kind: "verifying" }).cancellable).toBe(true);
    expect(view({ kind: "finalizing" }).cancellable).toBe(false);
    expect(view({ kind: "writing" }).cancellable).toBe(false);
  });

  it("shows a conversion's own fraction rather than the finished byte count", () => {
    expect(view({ kind: "remuxing", fraction: 0.456 }, 900, 900).percent).toBe(46);
    expect(view({ kind: "merging", fraction: null }, 900, 900).percent).toBeUndefined();
  });

  it("counts the minutes retained bytes stay usable, and none once they expired", () => {
    expect(retainedMinutes(10 * 60_000, 0)).toBe(10);
    expect(retainedMinutes(61_000, 0)).toBe(2);
    expect(retainedMinutes(1_000, 0)).toBe(1);
    expect(retainedMinutes(0, 0)).toBeNull();
  });
});
