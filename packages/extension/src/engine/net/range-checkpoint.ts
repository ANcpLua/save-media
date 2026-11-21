import { stableAddress } from "../../util/media-address";

export interface RangeCheckpoint {
  representation: string;
  parts: (Blob | undefined)[];
}

export interface RangeResume {
  previous: RangeCheckpoint | undefined;
  interrupted: (checkpoint: RangeCheckpoint) => void;
}

// Keep at most one interrupted file in the engine's memory. Signed addresses
// never enter the checkpoint, and a browser/extension restart releases it.
export const MAX_RESUME_BYTES = 256 * 1024 * 1024;
const RETENTION_MS = 10 * 60_000;
let retained: { scope: string; checkpoint: RangeCheckpoint; expires: number } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

export async function resumeIdentity(scope: string, url: string, qualifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([scope, stableAddress(url), qualifier]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export function getCheckpoint(scope: string): RangeCheckpoint | undefined {
  if (retained?.scope !== scope) return undefined;
  if (Date.now() < retained.expires) return retained.checkpoint;
  clearCheckpoint(scope);
  return undefined;
}

export function clearCheckpoint(scope: string): void {
  if (retained?.scope !== scope) return;
  clearTimeout(timer);
  retained = undefined;
}

export function keepCheckpoint(scope: string, checkpoint: RangeCheckpoint): void {
  clearTimeout(timer);
  retained = {scope, checkpoint, expires: Date.now() + RETENTION_MS};
  timer = setTimeout(() => { retained = undefined; }, RETENTION_MS);
}
