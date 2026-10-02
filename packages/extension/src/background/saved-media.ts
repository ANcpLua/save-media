import type { MediaInfo } from "../engine/probe-media";

/**
 * Every download is recorded so the same video is never saved twice.
 *
 * Same video: durations within 0.1 s, same orientation, and, when both sides
 * have a frame hash, at most 10 of 64 bits apart. Re-encodes of one source at
 * other resolutions keep the duration to the millisecond, which is what
 * separates them from different videos.
 *
 * Quality is the pixel count. A copy with more pixels is downloaded and the
 * worse copies are deleted once it has finished; a copy with equal or fewer
 * pixels is refused before anything is downloaded.
 */
export interface SavedMedia extends MediaInfo {
  readonly downloadId: number;
  readonly filename: string;
  /** Worse copies to delete once this download completes. */
  readonly replaces: readonly number[];
}

export type SaveDecision =
  | { readonly kind: "save"; readonly replaces: readonly SavedMedia[] }
  | { readonly kind: "skip"; readonly existing: SavedMedia };

const DURATION_TOLERANCE_SEC = 0.1;
const MAX_HASH_DISTANCE = 10;

export class AlreadySavedError extends Error {
  constructor(readonly existing: string) {
    super(`already saved in equal or better quality as ${existing}`);
  }
}

export function isSameVideo(a: MediaInfo, b: MediaInfo): boolean {
  if (Math.abs(a.durationSec - b.durationSec) > DURATION_TOLERANCE_SEC) return false;
  if ((a.width >= a.height) !== (b.width >= b.height)) return false;
  if (a.frameHash && b.frameHash) return hammingDistance(a.frameHash, b.frameHash) <= MAX_HASH_DISTANCE;
  return true;
}

export function decideSave(saved: readonly SavedMedia[], info: MediaInfo): SaveDecision {
  const same = saved.filter(s => isSameVideo(s, info));
  const best = same.reduce<SavedMedia | null>((top, s) => (!top || pixels(s) > pixels(top) ? s : top), null);
  if (best && pixels(best) >= pixels(info)) return { kind: "skip", existing: best };
  return { kind: "save", replaces: same };
}

function pixels(m: MediaInfo): number {
  return m.width * m.height;
}

function hammingDistance(a: string, b: string): number {
  let d = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
  return d;
}

export interface DownloadRequest {
  readonly url: string;
  readonly filename: string;
  readonly conflictAction?: string;
}

export interface SavedMediaDeps {
  readonly probe: (url: string) => Promise<MediaInfo | null>;
  readonly download: (opts: DownloadRequest) => Promise<number>;
  readonly read: () => Promise<readonly SavedMedia[]>;
  readonly write: (list: readonly SavedMedia[]) => Promise<void>;
  /** False once the file is gone or its download was interrupted. */
  readonly exists: (downloadId: number) => Promise<boolean>;
  readonly remove: (downloadId: number) => Promise<void>;
}

export function createSavedMediaGuard(deps: SavedMediaDeps) {
  // Serialized so two downloads of one video started together cannot both
  // pass the check before either is recorded.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function live(): Promise<SavedMedia[]> {
    const list = await deps.read();
    const kept: SavedMedia[] = [];
    for (const s of list) if (await deps.exists(s.downloadId)) kept.push(s);
    if (kept.length !== list.length) await deps.write(kept);
    return kept;
  }

  return {
    /** Downloads unless an equal or better copy is saved; throws AlreadySavedError then. */
    download(opts: DownloadRequest): Promise<number> {
      return serial(async () => {
        const info = await deps.probe(opts.url);
        if (!info) return deps.download(opts);
        const saved = await live();
        const decision = decideSave(saved, info);
        if (decision.kind === "skip") throw new AlreadySavedError(decision.existing.filename);
        const downloadId = await deps.download(opts);
        const entry: SavedMedia = { ...info, downloadId, filename: opts.filename, replaces: decision.replaces.map(s => s.downloadId) };
        await deps.write([...saved, entry]);
        return downloadId;
      });
    },

    /** Called when a download finishes: deletes the worse copies it replaces. */
    completed(downloadId: number): Promise<void> {
      return serial(async () => {
        const saved = await deps.read();
        const entry = saved.find(s => s.downloadId === downloadId);
        if (!entry || entry.replaces.length === 0) return;
        for (const id of entry.replaces) await deps.remove(id);
        await deps.write(saved
          .filter(s => !entry.replaces.includes(s.downloadId))
          .map(s => (s === entry ? { ...entry, replaces: [] } : s)));
      });
    },
  };
}
