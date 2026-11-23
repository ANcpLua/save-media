import type { JobError } from "@savemedia/core";
import { helperOutdated, type HostPong } from "../types/native";
import type { LocalJobView, LocalSettingsValue } from "../types/messages";
import type { NativeHostClient } from "./host-client";
import {
  loadLocalSettings,
  resolveCookieBrowser,
  saveLocalSettings,
  type LocalDownloaderSettings,
  type BrowserIdentity,
  type StorageLike,
} from "./settings";

/**
 * Failures a local yt-dlp run may handle better than the browser, which is
 * limited by memory and by the containers it can put together. None of them
 * involves protected media.
 *
 * Deliberately an allowlist. Every protection code (encrypted_media_detected,
 * cdm_required, license_bound_stream, clearkey_deferred) is absent: a local
 * run is never the answer to "the media is protected".
 */
export const DELEGABLE_ERROR_CODES: ReadonlySet<JobError["code"]> = new Set<JobError["code"]>([
  "dash_unsupported",
  "codec_unsupported",
  "hls_encryption_unsupported",
  "hls_layout_unsupported",
  "output_too_large_for_browser",
  "unsupported_output",
  "manifest_malformed",
  "engine_job_failed",
  // A server that did not let the browser finish a direct file.
  "transfer_failed",
  "verification_container",
]);

export function isDelegableError(error: JobError): boolean {
  return DELEGABLE_ERROR_CODES.has(error.code);
}

export interface PermissionsLike {
  readonly contains: (perm: { readonly permissions: readonly string[] }) => Promise<boolean>;
}

export interface LocalDownloaderDeps {
  readonly client: NativeHostClient;
  readonly storage: StorageLike;
  readonly permissions: PermissionsLike;
  readonly env: BrowserIdentity;
  /** `origin`: who asked for the job. Alt+S owes its tab a toast when the job ends; the popup shows its own jobs. */
  readonly onJobUpdate: (job: LocalJobView, origin: "hotkey" | "popup") => void;
  readonly newId?: () => string;
}

export interface LocalStatus {
  readonly settings: LocalDownloaderSettings;
  readonly host: HostPong | null;
  readonly permissionGranted: boolean;
  readonly jobs: readonly LocalJobView[];
}

export interface LocalDownloader {
  /** Persist a settings patch. Enabling without the permission stays off; the popup requests it. */
  readonly updateSettings: (patch: Partial<LocalSettingsValue>) => Promise<LocalDownloaderSettings>;
  readonly status: () => Promise<LocalStatus>;
  /** Start a download for a page URL. Returns the job view (phase "probing"), or null when disabled or when the helper is outdated. */
  readonly start: (pageUrl: string, tabId: number | null) => Promise<LocalJobView | null>;
  /** Hotkey fallback: only when enabled and the user opted into fallback. */
  readonly startFallback: (pageUrl: string, tabId: number | null) => Promise<LocalJobView | null>;
  readonly cancel: (id: string) => void;
}

const NATIVE_PERMISSION = { permissions: ["nativeMessaging"] } as const;
const MAX_FINISHED_JOBS = 10;
const PONG_CACHE_MS = 30_000;

export function createLocalDownloader(deps: LocalDownloaderDeps): LocalDownloader {
  const jobs = new Map<string, LocalJobView>();
  const cancels = new Map<string, () => void>();
  /** The jobs Alt+S started, or joined while they ran. */
  const byHotkey = new Set<string>();
  const newId = deps.newId ?? (() => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  let pongCache: { readonly at: number; readonly value: HostPong } | null = null;

  function update(job: LocalJobView): void {
    jobs.set(job.id, job);
    deps.onJobUpdate(job, byHotkey.has(job.id) ? "hotkey" : "popup");
    if (job.phase === "complete" || job.phase === "failed") byHotkey.delete(job.id);
    pruneFinished();
  }

  function pruneFinished(): void {
    const finished = [...jobs.values()].filter(j => j.phase === "complete" || j.phase === "failed");
    for (const j of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(j.id);
  }

  async function hasPermission(): Promise<boolean> {
    try {
      return await deps.permissions.contains(NATIVE_PERMISSION);
    } catch {
      return false;
    }
  }

  /** One host process per popup session, not one per message. */
  async function ping(): Promise<HostPong | null> {
    const now = Date.now();
    if (pongCache && now - pongCache.at < PONG_CACHE_MS) return pongCache.value;
    const value = await deps.client.ping();
    pongCache = value ? { at: now, value } : null;
    return value;
  }

  async function updateSettings(patch: Partial<LocalSettingsValue>): Promise<LocalDownloaderSettings> {
    const enabled = patch.enabled === true && !(await hasPermission()) ? false : patch.enabled;
    return saveLocalSettings(deps.storage, enabled === undefined ? patch : { ...patch, enabled });
  }

  async function start(pageUrl: string, tabId: number | null, fallback = false): Promise<LocalJobView | null> {
    const settings = await loadLocalSettings(deps.storage);
    if (!settings.enabled || (fallback && !settings.fallbackOnHotkey) || !(await hasPermission())) return null;
    if (!/^https?:\/\//i.test(pageUrl)) return null;
    // A helper that speaks an earlier protocol is not used: the popup asks the user to update it.
    // A helper that does not answer is left to the download itself, whose failure says so.
    const helper = await ping();
    if (helper && helperOutdated(helper)) return null;
    const active = [...jobs.values()].find(job => job.tabId === tabId && job.pageUrl === pageUrl
      && job.phase !== "complete" && job.phase !== "failed");
    if (active) {
      if (fallback) byHotkey.add(active.id);
      return active;
    }

    const id = newId();
    if (fallback) byHotkey.add(id);
    const initial: LocalJobView = {
      id, pageUrl, tabId,
      phase: "probing",
      percent: null, downloadedBytes: null, totalBytes: null, speedBytesPerSec: null, etaSeconds: null,
      filename: null, failure: null,
    };
    update(initial);

    const cancel = deps.client.download(
      {
        id,
        pageUrl,
        quality: settings.quality,
        cookiesFromBrowser: resolveCookieBrowser(settings.cookies, deps.env),
        allowWithoutCookies: settings.cookies === "auto",
        outputDir: null,
      },
      {
        onProgress: p => update({
          ...(jobs.get(id) ?? initial),
          phase: p.phase,
          percent: p.percent,
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes,
          speedBytesPerSec: p.speedBytesPerSec,
          etaSeconds: p.etaSeconds,
        }),
        onComplete: c => {
          cancels.delete(id);
          update({ ...(jobs.get(id) ?? initial), phase: "complete", percent: 100, filename: c.filename, failure: null });
        },
        onFailed: f => {
          cancels.delete(id);
          update({ ...(jobs.get(id) ?? initial), phase: "failed", failure: { code: f.code, message: f.message, httpStatus: f.httpStatus ?? null } });
        },
      },
    );
    const current = jobs.get(id);
    if (current && current.phase !== "complete" && current.phase !== "failed") cancels.set(id, cancel);
    return initial;
  }

  return {
    updateSettings,
    status: async () => {
      const permissionGranted = await hasPermission();
      return {
        settings: await loadLocalSettings(deps.storage),
        host: permissionGranted ? await ping() : null,
        permissionGranted,
        jobs: [...jobs.values()],
      };
    },
    start,
    startFallback: (pageUrl, tabId) => start(pageUrl, tabId, true),
    cancel: id => cancels.get(id)?.(),
  };
}
