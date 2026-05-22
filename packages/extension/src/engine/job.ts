import type { StreamDescriptor, UserChoice } from "@savemedia/core";

export type ProgressFn = (bytesWritten: number, bytesTotal: number | null, phase: string) => void;

export interface JobResult {
  readonly blobUrl: string;
  readonly filename: string;
  readonly checksum: string;
}

export type DownloadJob = (
  descriptor: StreamDescriptor,
  choice: UserChoice,
  onProgress: ProgressFn,
  signal: AbortSignal,
) => Promise<JobResult>;
