import { describe, expect, it, vi } from "vitest";
import { handleInstalled, KNOWN_STORAGE_KEYS } from "../../../src/background/installed";
import { LOCAL_SETTINGS_KEY } from "../../../src/native/settings";

function build(initial: Record<string, unknown>, permission: boolean) {
  const data: Record<string, unknown> = { ...initial };
  const deps = {
    storage: {
      getAll: vi.fn(async () => ({ ...data })),
      set: vi.fn(async (items: Readonly<Record<string, unknown>>) => { Object.assign(data, items); }),
      remove: vi.fn(async (keys: readonly string[]) => { for (const k of keys) delete data[k]; }),
    },
    permissions: { contains: vi.fn(async () => permission) },
    log: vi.fn(),
  };
  return { data, deps };
}

describe("onInstalled update cleanup", () => {
  it("does nothing on a fresh install or a browser update", async () => {
    const { deps } = build({ leftover: 1 }, true);
    await handleInstalled({ reason: "install" }, deps, "0.0.8");
    await handleInstalled({ reason: "chrome_update" }, deps, "0.0.8");
    expect(deps.storage.getAll).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("drops storage keys no version writes any more and keeps the known ones", async () => {
    const settings = { enabled: false, quality: "720", cookies: "auto", fallbackOnHotkey: true };
    const { data, deps } = build({ leftover: 1, [LOCAL_SETTINGS_KEY]: settings }, true);
    await handleInstalled({ reason: "update", previousVersion: "0.0.7" }, deps, "0.0.8");
    expect(deps.storage.remove).toHaveBeenCalledWith(["leftover"]);
    expect(Object.keys(data)).toEqual([...KNOWN_STORAGE_KEYS]);
    expect(data[LOCAL_SETTINGS_KEY]).toEqual(settings);
    expect(deps.log).toHaveBeenCalledWith("updated 0.0.7 -> 0.0.8; removed 1 stale storage key(s)");
  });

  it("re-parses the local downloader settings so unknown fields go and defaults fill in", async () => {
    const { data, deps } = build({ [LOCAL_SETTINGS_KEY]: { enabled: true, quality: "4k", obsolete: "x" } }, true);
    await handleInstalled({ reason: "update" }, deps, "0.0.8");
    expect(data[LOCAL_SETTINGS_KEY]).toEqual({ enabled: true, quality: "best", cookies: "auto", fallbackOnHotkey: true });
  });

  it("switches the local downloader off when the nativeMessaging permission is not granted", async () => {
    const { data, deps } = build({ [LOCAL_SETTINGS_KEY]: { enabled: true, quality: "best", cookies: "none", fallbackOnHotkey: false } }, false);
    await handleInstalled({ reason: "update" }, deps, "0.0.8");
    expect(data[LOCAL_SETTINGS_KEY]).toEqual({ enabled: false, quality: "best", cookies: "none", fallbackOnHotkey: false });
  });

  it("leaves storage untouched when there is nothing persisted", async () => {
    const { deps } = build({}, false);
    await handleInstalled({ reason: "update" }, deps, "0.0.8");
    expect(deps.storage.remove).not.toHaveBeenCalled();
    expect(deps.storage.set).not.toHaveBeenCalled();
  });
});
