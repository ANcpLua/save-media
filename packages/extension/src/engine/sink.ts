import type { JobResult } from "./job";
import { BlobParts } from "./blob-parts";

/**
 * Where an engine job writes its file. There is deliberately one
 * implementation today, InMemorySink; the boundary lets tests inject a sink
 * that captures what a job wrote.
 *
 * write() appends: callers hand over bytes in the order they appear in the
 * final file, as byte arrays or as a Blob that already holds a finished
 * stretch of it. close() returns the job's result. abort() releases what
 * was written without a result.
 */
export interface JobSink {
  open(filename: string, expectedSize: number | null): Promise<void>;
  write(bytes: Uint8Array | Blob): Promise<void>;
  close(): Promise<JobResult>;
  abort(): Promise<void>;
}

/**
 * The sink every job uses: the file as one Blob, handed to the browser's
 * downloads by its address. Written bytes are folded into Blobs as they
 * arrive (blob-parts), so the engine document itself never holds the file.
 * Large outputs are refused before this path when their manifest gives
 * enough size information, and by the jobs' running size checks otherwise.
 */
export class InMemorySink implements JobSink {
  private readonly parts = new BlobParts();
  private filename = "";
  /** What the last file took, kept after close for a caller that reports it. */
  private bytes = 0;

  constructor(private readonly mime: string) {}

  async open(filename: string, _expectedSize?: number | null): Promise<void> {
    this.filename = filename;
    this.parts.clear();
    this.bytes = 0;
  }

  async write(bytes: Uint8Array | Blob): Promise<void> {
    this.parts.append(bytes);
    this.bytes = this.parts.size;
  }

  async close(): Promise<JobResult> {
    const blob = this.parts.toBlob(this.mime);
    // The Blob owns the bytes now.
    this.parts.clear();
    return {
      blobUrl: URL.createObjectURL(blob),
      filename: this.filename,
      checksum: "",
    };
  }

  async abort(): Promise<void> {
    this.parts.clear();
    this.bytes = 0;
  }

  byteLength(): number { return this.bytes; }
}
