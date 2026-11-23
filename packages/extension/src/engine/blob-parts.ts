/**
 * The engine document's memory is the engine's hard limit, so a job never
 * holds a whole file as byte arrays. Bytes are folded into Blobs as they
 * arrive: a Blob's data belongs to the browser, which keeps it outside the
 * document and can move it to disk, and reading a part back is one slice.
 */

/** The most bytes a job holds as byte arrays before they move into a Blob. */
export const FOLD_BYTES = 16 * 1024 * 1024;

/** Bytes appended in order, held as Blobs except for the last, unfolded ones. */
export class BlobParts {
  private blobs: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private bytes = 0;

  /** The caller must not change `part` afterwards: it is kept, not copied, until it is folded. */
  append(part: Uint8Array | Blob): void {
    if (ArrayBuffer.isView(part)) {
      if (!part.byteLength) return;
      this.pending.push(part);
      this.pendingBytes += part.byteLength;
      this.bytes += part.byteLength;
      if (this.pendingBytes >= FOLD_BYTES) this.fold();
      return;
    }
    if (!part.size) return;
    this.fold();
    this.blobs.push(part);
    this.bytes += part.size;
  }

  get size(): number { return this.bytes; }

  /** Everything appended so far as one Blob. More can be appended afterwards. */
  toBlob(type = ""): Blob {
    this.fold();
    return new Blob(this.blobs, { type });
  }

  clear(): void {
    this.blobs = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.bytes = 0;
  }

  private fold(): void {
    if (!this.pending.length) return;
    this.blobs.push(new Blob(this.pending as BlobPart[]));
    this.pending = [];
    this.pendingBytes = 0;
  }
}

/**
 * A file written at positions, as a muxer writes it: in order, except for the
 * few header fields it fills in at the end. The ordered bytes fold into Blobs;
 * a write over earlier bytes is kept as a patch and laid over them when the
 * file is built, so nothing already folded is read back.
 */
export class PositionedBlob {
  private readonly body = new BlobParts();
  private patches: { readonly position: number; readonly data: Uint8Array }[] = [];

  write(data: Uint8Array, position: number): void {
    const end = this.body.size;
    // A position past the end leaves a gap, which a file holds as zero bytes.
    if (position > end) this.body.append(new Uint8Array(position - end));
    if (position >= end) {
      this.body.append(data);
      return;
    }
    const over = Math.min(data.byteLength, end - position);
    this.patches.push({ position, data: data.slice(0, over) });
    if (over < data.byteLength) this.body.append(data.subarray(over));
  }

  get size(): number { return this.body.size; }

  toBlob(type = ""): Blob {
    let blob = this.body.toBlob(type);
    // In the order written: a later write over the same bytes wins.
    for (const { position, data } of this.patches) {
      blob = new Blob([blob.slice(0, position), data as BlobPart, blob.slice(position + data.byteLength)], { type });
    }
    return blob;
  }

  clear(): void {
    this.body.clear();
    this.patches = [];
  }
}
