import type { JobSink } from "../../../../src/engine/sink";
import type { JobResult } from "../../../../src/engine/job";

/** A sink that keeps what a job writes, so a test can read the saved file's bytes. */
export class CapturingSink implements JobSink {
  openedFilename: string | null = null;
  expectedSize: number | null = null;
  /** One entry per write, in order. A Blob the job wrote is read into bytes. */
  writes: Uint8Array[] = [];
  aborted = false;

  async open(filename: string, expectedSize: number | null = null): Promise<void> {
    this.openedFilename = filename;
    this.expectedSize = expectedSize;
  }

  async write(part: Uint8Array | Blob): Promise<void> {
    // isView, not instanceof: under jsdom a byte array can come from another realm.
    this.writes.push(ArrayBuffer.isView(part) ? new Uint8Array(part as Uint8Array) : new Uint8Array(await (part as Blob).arrayBuffer()));
  }

  async close(): Promise<JobResult> {
    return { blobUrl: "blob:unit-test", filename: this.openedFilename ?? "", checksum: "" };
  }

  async abort(): Promise<void> { this.aborted = true; }

  get filename(): string { return this.openedFilename ?? ""; }

  /** The whole file as written. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.writes.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of this.writes) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}
