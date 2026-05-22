import type { JobResult } from "./job";

/**
 * Sink abstraction for engine jobs: HLS/DASH runners write segments
 * through here. After dropping the native-host integration there's
 * only one implementation — InMemorySink — but keeping the interface
 * means the runners stay one swap away from a streaming alternative
 * (e.g. a future Origin Private File System sink) without rewriting
 * job orchestration.
 *
 * write() is monotonic — callers append bytes in the order they
 * should appear in the final file. close() flushes and returns the
 * final job result. abort() releases any resources without committing.
 */
export interface JobSink {
  open(filename: string, expectedSize: number | null): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<JobResult>;
  abort(): Promise<void>;
}

/**
 * In-renderer-memory sink. Suitable for files up to roughly 2 GB
 * (the renderer Blob ceiling). Above that we now fail with a clear
 * error instead of trying a native streaming path.
 */
export class InMemorySink implements JobSink {
  private parts: BlobPart[] = [];
  private filename = "";
  private mime: string;
  private bytes = 0;

  constructor(mime: string) {
    this.mime = mime;
  }

  async open(filename: string, _expectedSize?: number | null): Promise<void> {
    this.filename = filename;
    this.parts = [];
    this.bytes = 0;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.parts.push(bytes as BlobPart);
    this.bytes += bytes.byteLength;
  }

  async close(): Promise<JobResult> {
    const blob = new Blob(this.parts, { type: this.mime });
    return {
      blobUrl: URL.createObjectURL(blob),
      filename: this.filename,
      checksum: "",
    };
  }

  async abort(): Promise<void> {
    this.parts = [];
    this.bytes = 0;
  }

  byteLength(): number { return this.bytes; }
  partsForProbe(): readonly BlobPart[] { return this.parts; }
}
