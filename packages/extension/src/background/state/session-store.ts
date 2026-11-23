// The service worker's state in chrome.storage.session, written in batches.
// Memory stays the source of truth: the store is read once, when a worker
// starts, and every later change is queued here. No timer paces the writes:
// the changes of one task become one write, and changes made while a write
// is under way become exactly one more.
import type { Logger } from "../../util/logger";
import { toWire } from "../../util/wire";

export interface SessionArea {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** The stored size of these keys, where the browser reports it. */
  getBytesInUse?(keys: string[]): Promise<number>;
}

export interface SessionStore {
  /** Everything stored, read once. A store that cannot be read is empty. */
  load(): Promise<ReadonlyMap<string, unknown>>;
  /** Queue a value. The latest value of a key wins. */
  put(key: string, value: unknown): void;
  delete(key: string): void;
  /** Resolves when every put and delete issued before the call was written, or failed for good. */
  durable(): Promise<void>;
}

export interface SessionStoreOptions {
  /**
   * What may be dropped when the browser refuses a write, as groups of keys
   * that go together: one tab's state, or the diagnostics. The group that
   * takes the most room goes first, so the tab that filled the store loses
   * its own stored state before any other tab does.
   */
  readonly expendable?: () => readonly (readonly string[])[];
  readonly logger?: Logger;
}

const DELETE = Symbol("delete");

export function createSessionStore(area: SessionArea | undefined, options: SessionStoreOptions = {}): SessionStore {
  let pending = new Map<string, unknown>();
  let seq = 0;
  let written = 0;
  let writing = false;
  let scheduled = false;
  let degraded = false;
  const waiters: { readonly upTo: number; readonly resolve: () => void }[] = [];

  function settle(): void {
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index]!.upTo <= written) waiters.splice(index, 1)[0]!.resolve();
    }
  }

  function schedule(): void {
    if (writing || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void flush(); });
  }

  async function write(values: Record<string, unknown>, removed: string[]): Promise<void> {
    if (Object.keys(values).length) await area!.set(values);
    if (removed.length) await area!.remove(removed);
  }

  async function flush(): Promise<void> {
    if (writing || !pending.size) { settle(); return; }
    writing = true;
    const batch = pending;
    const upTo = seq;
    pending = new Map();
    const values: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const [key, value] of batch) {
      if (value === DELETE) removed.push(key);
      else values[key] = toWire(value);
    }
    try {
      await write(values, removed);
    } catch {
      // The only realistic refusal is the quota; the error's text is never read.
      if (!await makeRoom(values, removed)) {
        if (!degraded) options.logger?.warn("persistence_degraded");
        degraded = true;
      }
    }
    writing = false;
    written = upTo;
    settle();
    if (pending.size) schedule();
  }

  const textSize = (value: unknown): number => {
    try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
  };

  /**
   * The browser refused the batch. Drop expendable groups one at a time, the
   * largest first, and write again after each; a dropped group's own values
   * of this batch are not written either. When nothing expendable is left,
   * the values are written one by one, smallest first, so a single value
   * that does not fit never takes the others with it. True when everything
   * that was still to be written is stored.
   */
  async function makeRoom(values: Record<string, unknown>, removed: string[]): Promise<boolean> {
    const groups = (options.expendable?.() ?? []).filter(group => group.length > 0);
    const sized = await Promise.all(groups.map(async group => {
      const stored = area!.getBytesInUse ? await area!.getBytesInUse([...group]).catch(() => 0) : 0;
      const coming = group.reduce((sum, key) => sum + (key in values ? textSize(values[key]) : 0), 0);
      return { group, bytes: stored + coming };
    }));
    // A stable sort: without sizes the given order stands.
    sized.sort((a, b) => b.bytes - a.bytes);
    for (const { group } of sized) {
      for (const key of group) delete values[key];
      try {
        await area!.remove([...group]);
        await write(values, removed);
        return true;
      } catch { /* The next group. */ }
    }
    let all = true;
    for (const key of Object.keys(values).sort((a, b) => textSize(values[a]) - textSize(values[b]))) {
      try { await area!.set({ [key]: values[key] }); }
      catch { all = false; }
    }
    if (removed.length) await area!.remove(removed).catch(() => { all = false; });
    return all;
  }

  function change(key: string, value: unknown): void {
    seq++;
    if (!area) { written = seq; return; }
    pending.set(key, value);
    schedule();
  }

  return {
    async load() {
      if (!area) return new Map();
      try { return new Map(Object.entries(await area.get(null))); }
      catch { return new Map(); }
    },
    put: (key, value) => change(key, value),
    delete: key => change(key, DELETE),
    durable() {
      if (written >= seq) return Promise.resolve();
      const upTo = seq;
      return new Promise(resolve => { waiters.push({ upTo, resolve }); });
    },
  };
}
