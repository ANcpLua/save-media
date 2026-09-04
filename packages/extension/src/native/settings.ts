import {
  isCookieBrowser,
  isLocalQuality,
  type CookieBrowser,
  type LocalQuality,
} from "../types/native";

export type CookieSource = "auto" | "none" | CookieBrowser;

export interface LocalDownloaderSettings {
  /** User opted in. Also implies the nativeMessaging permission was granted. */
  readonly enabled: boolean;
  readonly quality: LocalQuality;
  /** Which browser's cookie store the host may read. "auto" picks the running browser. */
  readonly cookies: CookieSource;
  /**
   * When Alt+S finds nothing the in-browser engine can save (or the engine
   * refuses for a non-DRM reason), hand the page URL to the local host.
   */
  readonly fallbackOnHotkey: boolean;
}

export const DEFAULT_LOCAL_SETTINGS: LocalDownloaderSettings = {
  enabled: false,
  quality: "best",
  cookies: "auto",
  fallbackOnHotkey: true,
};

export const LOCAL_SETTINGS_KEY = "localDownloader" as const;

export interface StorageLike {
  readonly get: (key: string) => Promise<Readonly<Record<string, unknown>>>;
  readonly set: (items: Readonly<Record<string, unknown>>) => Promise<void>;
}

export function parseLocalSettings(value: unknown): LocalDownloaderSettings {
  if (value === null || typeof value !== "object") return DEFAULT_LOCAL_SETTINGS;
  const v = value as Readonly<Record<string, unknown>>;
  return {
    enabled: v.enabled === true,
    quality: isLocalQuality(v.quality) ? v.quality : DEFAULT_LOCAL_SETTINGS.quality,
    cookies: isCookieSource(v.cookies) ? v.cookies : DEFAULT_LOCAL_SETTINGS.cookies,
    fallbackOnHotkey: typeof v.fallbackOnHotkey === "boolean" ? v.fallbackOnHotkey : DEFAULT_LOCAL_SETTINGS.fallbackOnHotkey,
  };
}

export function isCookieSource(value: unknown): value is CookieSource {
  return value === "auto" || value === "none" || isCookieBrowser(value);
}

export async function loadLocalSettings(storage: StorageLike): Promise<LocalDownloaderSettings> {
  try {
    const items = await storage.get(LOCAL_SETTINGS_KEY);
    return parseLocalSettings(items[LOCAL_SETTINGS_KEY]);
  } catch {
    return DEFAULT_LOCAL_SETTINGS;
  }
}

export async function saveLocalSettings(
  storage: StorageLike,
  patch: Partial<LocalDownloaderSettings>,
): Promise<LocalDownloaderSettings> {
  const current = await loadLocalSettings(storage);
  const next = parseLocalSettings({ ...current, ...patch });
  await storage.set({ [LOCAL_SETTINGS_KEY]: next });
  return next;
}

/**
 * Resolve the "auto" cookie source to the browser this extension runs in.
 * The host passes the name to yt-dlp's `--cookies-from-browser`.
 */
export function resolveCookieBrowser(
  source: CookieSource,
  env: { readonly browser: "chromium" | "firefox"; readonly userAgent: string },
): CookieBrowser | null {
  if (source === "none") return null;
  if (source !== "auto") return source;
  if (env.browser === "firefox") return "firefox";
  const ua = env.userAgent;
  if (/\bEdg\//.test(ua)) return "edge";
  if (/\bBrave\b/.test(ua)) return "brave";
  if (/\bChrome\//.test(ua)) return "chrome";
  return "chromium";
}
