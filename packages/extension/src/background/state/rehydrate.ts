// A worker start: read the stored state once, drop what belongs to tabs that
// are gone, and hand the rest to the modules that own it. This runs before
// any event is handled (every listener waits for it), and it only fills
// empty state, so nothing can be applied twice.
import type { Logger } from "../../util/logger";
import { fromWire } from "../../util/wire";
import type { RouterPersistence } from "../router";
import { keysOfTabs, readStoredState, stateKeys, type StoredState } from "./records";
import type { SessionStore } from "./session-store";

export interface RehydrateDeps {
  /** The ids of the tabs that are open now. */
  readonly openTabs: () => Promise<ReadonlySet<number>>;
  /** Fill the modules' memory. */
  readonly apply: (state: StoredState) => void;
  readonly logger?: Logger;
}

export async function rehydrate(store: SessionStore, deps: RehydrateDeps): Promise<void> {
  const raw = await store.load();
  const entries = new Map<string, unknown>();
  for (const [key, value] of raw) entries.set(key, fromWire(value));
  const state = readStoredState(entries);
  for (const key of state.invalid) store.delete(key);

  let open: ReadonlySet<number>;
  try { open = await deps.openTabs(); }
  catch {
    // Without the tab list nothing is dropped: a record of a closed tab is harmless until its tab id is reused.
    open = new Set([...state.tabs.keys(), ...state.media.keys(), ...state.diagnostics.keys(), ...state.loaded, ...state.toolbar]);
  }
  const closed = new Set<number>();
  for (const map of [state.tabs, state.descriptors, state.covered, state.media, state.origins, state.received, state.activity, state.facts,
    state.diagnostics]) {
    for (const tabId of [...map.keys()]) {
      if (open.has(tabId)) continue;
      closed.add(tabId);
      map.delete(tabId);
    }
  }
  if (closed.size) for (const key of keysOfTabs(raw.keys(), closed)) store.delete(key);
  const prune = <T extends { readonly tabId: number }>(key: string, records: readonly T[]): readonly T[] => {
    const kept = records.filter(record => open.has(record.tabId));
    if (kept.length !== records.length) store.put(key, kept);
    return kept;
  };
  const pruneIds = (key: string, ids: readonly number[]): readonly number[] => {
    const kept = ids.filter(id => open.has(id));
    if (kept.length !== ids.length) store.put(key, kept);
    return kept;
  };
  state.prompts = prune(stateKeys.prompts, state.prompts);
  state.recoveries = prune(stateKeys.recoveries, state.recoveries);
  state.loaded = pruneIds(stateKeys.loaded, state.loaded);
  state.toolbar = pruneIds(stateKeys.toolbar, state.toolbar);
  state.notices = prune(stateKeys.notices, state.notices);
  // Job records stay: a save outlives its tab.
  try {
    deps.apply(state);
  } catch (error) {
    deps.logger?.error("stored state could not be applied", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** The router's persistence over a session store. */
export function routerPersistence(store: SessionStore): RouterPersistence {
  return {
    tab: record => store.put(stateKeys.tab(record.tabId), record),
    descriptor: (tabId, descriptor) => store.put(stateKeys.descriptor(tabId, descriptor.id), descriptor),
    dropDescriptor: (tabId, id) => store.delete(stateKeys.descriptor(tabId, id)),
    covered: (tabId, ids) => store.put(stateKeys.covered(tabId), ids),
    dropTab(tabId, ids) {
      for (const id of ids) store.delete(stateKeys.descriptor(tabId, id));
      store.delete(stateKeys.tab(tabId));
      store.delete(stateKeys.covered(tabId));
    },
    jobs: records => store.put(stateKeys.jobs, records),
    durable: () => store.durable(),
  };
}
