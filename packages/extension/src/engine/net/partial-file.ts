import { Sha256 } from "../crypto/sha256";
import { TransferError } from "./transfer-error";

/**
 * Saved bytes whose original response carried no version stamp are checked
 * against the current file before anything is appended to them. `read`
 * returns the server's bytes for [start, endExclusive), or a whole file the
 * server sent in place, which ends the comparison.
 */
export async function compareFilePrefix<W>(prefix: Blob, total: number, url: string, signal: AbortSignal,
  read: (start: number, endExclusive: number) => Promise<Uint8Array | { readonly whole: W }>): Promise<W | null> {
  if (prefix.size > total) throw new TransferError("content-mismatch", { url, received: prefix.size, expected: total });
  const blockSize = 4 * 1024 * 1024;
  for (let start = 0; start < prefix.size; start += blockSize) {
    signal.throwIfAborted();
    const end = Math.min(start + blockSize, prefix.size);
    const remote = await read(start, end);
    if (!(remote instanceof Uint8Array)) return remote.whole;
    const local = new Uint8Array(await prefix.slice(start, end).arrayBuffer());
    if (remote.length !== local.length || remote.some((byte, index) => byte !== local[index])) {
      throw new TransferError("content-mismatch", { url, received: prefix.size, expected: total });
    }
  }
  return null;
}

/** The file is hashed this many bytes at a time, so checking it never copies it whole into memory. */
const DIGEST_WINDOW_BYTES = 4 * 1024 * 1024;

/** A whole-file checksum the server stated must match the assembled file before it is published. */
export async function verifyFileDigest(blob: Blob, digest: string | undefined, signal: AbortSignal, url: string): Promise<void> {
  if (!digest) return;
  const sha = new Sha256();
  for (let start = 0; start < blob.size; start += DIGEST_WINDOW_BYTES) {
    signal.throwIfAborted();
    sha.update(new Uint8Array(await blob.slice(start, start + DIGEST_WINDOW_BYTES).arrayBuffer()));
  }
  signal.throwIfAborted();
  const actual = btoa(String.fromCharCode(...sha.digest()));
  if (actual !== digest) {
    throw new TransferError("checksum", { url, received: blob.size, expected: blob.size, digest: { expected: digest, actual } });
  }
}
