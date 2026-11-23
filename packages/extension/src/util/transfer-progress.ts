// The one place a transfer stage becomes text, for the popup, the toolbar
// title and the screen reader alike. Stages are data; nothing parses this
// text back.
//
// Wording rules (the same in every text catalogue): a label says what
// savemedia is doing now, in a few plain words. No part counts, no codes, no
// HTTP numbers, no protocol words. "…" is for buttons, not for labels.
import { formatBytes } from "@savemedia/core";
import type { TransferStage } from "../types/transfer";
import type { LocalPhase } from "../types/native";

export interface TransferState {
  readonly stage?: TransferStage | undefined;
  /** When the stage began, in ms since the epoch: what a wait counts down from. */
  readonly stageSince?: number | undefined;
  /** A percent the transfer reported itself, such as the Local downloader's. */
  readonly percent?: number | null | undefined;
  readonly bytesWritten?: number | undefined;
  readonly bytesTotal?: number | null | undefined;
}

/** What a Local downloader job reports, as far as its progress goes. */
export interface LocalJobProgress {
  readonly phase: LocalPhase | "complete" | "failed";
  readonly percent: number | null;
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
}

/**
 * A Local downloader job as the transfer it is, for the popup's row and the toolbar button alike. While
 * the downloader reads the page there is no file yet: that is "starting". It reports no fraction of its
 * join, and its percent only where it knows no sizes.
 */
export function localTransfer(job: LocalJobProgress): TransferState {
  const stage: TransferStage = job.phase === "merging" ? { kind: "merging", fraction: null }
    : job.phase === "downloading" ? { kind: "downloading" } : { kind: "starting" };
  return { stage, percent: job.percent, bytesTotal: job.totalBytes,
    ...(job.downloadedBytes !== null ? { bytesWritten: job.downloadedBytes } : {}) };
}

export interface TransferView {
  readonly label: string;
  readonly percent: number | undefined;
  /** "540.0 MB of 1.20 GB", "540.0 MB received", or null when no bytes are counted. */
  readonly bytesText: string | null;
  /** The transfer is waiting to try again. */
  readonly retrying: boolean;
  /** False once the file is being put together or handed to the browser. */
  readonly cancellable: boolean;
  /** What a screen reader is told when this stage begins; null for the stages that only move the bar. */
  readonly announce: string | null;
  /** The stage's wait is still running, so its label counts down. */
  readonly waiting: boolean;
}

const TRANSFERRING = new Set<TransferStage["kind"]>(["downloading", "segment", "track", "retrying", "reconnecting", "resuming"]);

export function describeTransfer(status: TransferState, now: number = Date.now()): TransferView {
  const stage: TransferStage = status.stage ?? { kind: "starting" };
  const transferring = TRANSFERRING.has(stage.kind);
  const converting = stage.kind === "remuxing" || stage.kind === "merging";
  const fraction = stage.kind === "segment" && stage.count > 0 ? stage.index / stage.count : converting ? stage.fraction : null;
  const left = waitLeft(stage, status.stageSince, now);
  return {
    label: stageLabel(stage, left),
    percent: converting ? (fraction === null ? undefined : clampPercent(fraction * 100))
      : transferring ? progressPercent(status, fraction) : undefined,
    bytesText: transferring ? bytesText(status) : null,
    retrying: stage.kind === "retrying" || stage.kind === "reconnecting" || stage.kind === "restarting",
    cancellable: stage.kind !== "finalizing" && stage.kind !== "writing",
    announce: announcement(stage),
    waiting: left !== null && left > 0,
  };
}

function bytesText(status: TransferState): string | null {
  if (status.bytesTotal) return `${formatBytes(status.bytesWritten ?? 0)} of ${formatBytes(status.bytesTotal)}`;
  return status.bytesWritten !== undefined ? `${formatBytes(status.bytesWritten)} received` : null;
}

/** The whole seconds left of a stage's wait, or null for a stage that does not wait. */
function waitLeft(stage: TransferStage, since: number | undefined, now: number): number | null {
  if (stage.kind !== "retrying" && stage.kind !== "reconnecting") return null;
  const elapsed = since === undefined ? 0 : Math.max(0, now - since);
  return Math.max(0, Math.ceil((stage.waitMs - elapsed) / 1000));
}

function stageLabel(stage: TransferStage, left: number | null): string {
  const wait = left ? ` in ${left} ${left === 1 ? "second" : "seconds"}` : "";
  switch (stage.kind) {
    case "starting": return "Starting";
    case "probing": return "Checking the file";
    case "playlist": return "Reading the playlist";
    case "downloading":
    case "segment": return "Downloading";
    case "track": return stage.track === "video" ? "Downloading video" : "Downloading audio";
    case "retrying": return stage.httpStatus !== null ? `The server is busy, trying again${wait}` : `Connection interrupted, trying again${wait}`;
    case "reconnecting": return `Connection lost, resuming${wait}`;
    case "resuming": return "Resuming the download";
    case "rechecking": return "Checking the part saved earlier";
    case "restarting": return stage.cause === "retained-rejected"
      ? "The saved part no longer matches, starting over"
      : "Starting the download over";
    case "remuxing": return "Converting to MP4";
    case "merging": return "Joining video and audio";
    case "verifying": return "Checking the finished file";
    case "finalizing": return "Preparing the file";
    case "writing": return "Saving to Downloads";
  }
}

/** Stage changes worth saying aloud. Byte progress and the first checks are not. */
function announcement(stage: TransferStage): string | null {
  switch (stage.kind) {
    case "retrying":
    case "reconnecting":
    case "restarting":
    case "resuming":
    case "remuxing":
    case "merging":
    case "verifying":
    case "writing":
      return stageLabel(stage, null);
    default:
      return null;
  }
}

function progressPercent(status: TransferState, fraction: number | null): number | undefined {
  if (status.bytesTotal && status.bytesTotal > 0) {
    return clampPercent(Math.floor(((status.bytesWritten ?? 0) / status.bytesTotal) * 100));
  }
  if (status.percent != null) return clampPercent(status.percent);
  return fraction === null ? undefined : clampPercent(fraction * 100);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** The minutes left to use retained bytes, at least one while they are kept, else null. */
export function retainedMinutes(expiresAt: number, now = Date.now()): number | null {
  const left = expiresAt - now;
  return left > 0 ? Math.max(1, Math.ceil(left / 60_000)) : null;
}
