import { canonicalAddress } from "../../util/media-address";
import type { RangeMetadata } from "./range-recovery";
import type { OutputContainer } from "@savemedia/core";

export interface RangeCheckpoint {
  kind: "ranges";
  representation: string;
  metadata: RangeMetadata;
  parts: (Blob | undefined)[];
}

export interface PrefixCheckpoint {
  kind: "prefix";
  entry: string;
  resource: string;
  total: number;
  prefix: Blob;
  metadata: RangeMetadata | null;
  container?: OutputContainer | undefined;
}

export type FileCheckpoint = RangeCheckpoint | PrefixCheckpoint;
export const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

export function checkpointSize(checkpoint: FileCheckpoint): number {
  return checkpoint.kind === "prefix" ? checkpoint.prefix.size
    : checkpoint.parts.reduce((size, part) => size + (part?.size ?? 0), 0);
}

export function checkpointTotal(checkpoint: FileCheckpoint): number {
  return checkpoint.kind === "prefix" ? checkpoint.total : checkpoint.metadata.total;
}

/** Sparse parts beyond the first gap belong to the old resource until independently verified. */
export function contiguousRangePrefix(saved: readonly (Blob | undefined)[]): Blob {
  const parts: Blob[] = [];
  for (const part of saved) {
    if (!part?.size) break;
    parts.push(part);
    if (part.size < RANGE_CHUNK_BYTES) break;
  }
  return new Blob(parts);
}

/** The checkpoint one running job holds. The engine keeps it for Retry save only once the job has failed. */
export interface RangeResume {
  readonly signal: AbortSignal;
  previous: FileCheckpoint | undefined;
  interrupted: (checkpoint: FileCheckpoint) => void;
  discard: () => void;
}

// Keep at most one interrupted file in the engine's memory. Addresses enter
// the checkpoint only as digests, and a browser/extension restart releases it.
export const MAX_RESUME_BYTES = 256 * 1024 * 1024;
/** The one retention constant: how long a failed save keeps its bytes for Retry save. */
const RETENTION_MS = 10 * 60_000;
let retained: { scope: string; checkpoint: FileCheckpoint; expires: number; onEvicted: (() => void) | undefined } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let onRelease: (() => void) | undefined;

/** Called whenever the engine stops holding retained bytes. */
export function onCheckpointRelease(listener: (() => void) | undefined): void {
  onRelease = listener;
}

export function holdsCheckpoint(): boolean {
  return retained !== undefined;
}

/** The resume scope of the bytes held for Retry save, or null. A restarted background compares it with what it promised. */
export function retainedScope(): string | null {
  return retained?.scope ?? null;
}

export async function resumeIdentity(scope: string, url: string, qualifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([scope, canonicalAddress(url), qualifier]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export function getCheckpoint(scope: string): FileCheckpoint | undefined {
  if (retained?.scope !== scope) return undefined;
  if (Date.now() < retained.expires) return retained.checkpoint;
  clearCheckpoint(scope);
  return undefined;
}

export function clearCheckpoint(scope: string): void {
  if (retained?.scope !== scope) return;
  clearTimeout(timer);
  retained = undefined;
  onRelease?.();
}

/**
 * Keeps a failed save's checkpoint for Retry save and returns when it
 * expires, or null when it is too large to keep. The engine keeps one: the
 * latest failure takes the slot, and the save it takes it from is told
 * through its `onEvicted`, so its failure message stops promising the bytes.
 */
export function keepCheckpoint(scope: string, checkpoint: FileCheckpoint, onEvicted?: () => void): number | null {
  // A running job can continue using its own larger Blob. Only bounded
  // checkpoints stay in the engine after the job ends for a manual retry.
  if (checkpointTotal(checkpoint) > MAX_RESUME_BYTES) {
    clearCheckpoint(scope);
    return null;
  }
  const evicted = retained && retained.scope !== scope && Date.now() < retained.expires ? retained.onEvicted : undefined;
  clearTimeout(timer);
  const expires = Date.now() + RETENTION_MS;
  retained = {scope, checkpoint, expires, onEvicted};
  timer = setTimeout(() => { retained = undefined; onRelease?.(); }, RETENTION_MS);
  evicted?.();
  return expires;
}
