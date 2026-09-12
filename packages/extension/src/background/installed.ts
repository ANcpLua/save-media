import { LOCAL_SETTINGS_KEY, parseLocalSettings } from "../native/settings";
import type { PermissionsLike } from "../native/local-downloader";

/** Every key this extension writes to chrome.storage.local. Anything else is left over from an earlier version. */
export const KNOWN_STORAGE_KEYS: readonly string[] = [LOCAL_SETTINGS_KEY];

export interface InstalledDeps {
  readonly storage: {
    readonly getAll: () => Promise<Readonly<Record<string, unknown>>>;
    readonly set: (items: Readonly<Record<string, unknown>>) => Promise<void>;
    readonly remove: (keys: readonly string[]) => Promise<void>;
  };
  readonly permissions: PermissionsLike;
  readonly log: (message: string) => void;
}

export interface InstalledDetails {
  readonly reason: string;
  readonly previousVersion?: string | undefined;
}

/**
 * Runs once after the browser installs a new version from the store. It keeps
 * persisted state consistent with the code that is now running: storage keys
 * no version writes any more are dropped, the local downloader settings are
 * re-parsed so removed fields disappear and new ones get their defaults, and
 * the opt-in flag is cleared when the optional nativeMessaging permission is
 * not actually granted (the popup treats the flag as proof of the grant).
 */
export async function handleInstalled(details: InstalledDetails, deps: InstalledDeps, currentVersion: string): Promise<void> {
  if (details.reason !== "update") return;
  const all = await deps.storage.getAll();

  const stale = Object.keys(all).filter(key => !KNOWN_STORAGE_KEYS.includes(key));
  if (stale.length > 0) await deps.storage.remove(stale);

  if (all[LOCAL_SETTINGS_KEY] !== undefined) {
    const parsed = parseLocalSettings(all[LOCAL_SETTINGS_KEY]);
    const granted = await deps.permissions.contains({ permissions: ["nativeMessaging"] });
    const next = parsed.enabled && !granted ? { ...parsed, enabled: false } : parsed;
    await deps.storage.set({ [LOCAL_SETTINGS_KEY]: next });
  }

  deps.log(`updated ${details.previousVersion ?? "?"} -> ${currentVersion}; removed ${stale.length} stale storage key(s)`);
}
