import type { JobError } from "@savemedia/core";
import type { HostPong } from "../types/native";
import type { LocalJobView, LocalSettingsValue } from "../types/messages";
import type { NativeHostClient } from "./host-client";
import {
  loadLocalSettings,
  resolveCookieBrowser,
  saveLocalSettings,
  type LocalDownloaderSettings,
  type StorageLike,
} from "./settings";

/**
 * Engine failures that a local yt-dlp run may legitimately handle better:
 * the browser engine is limited by CORS, memory, and the set of containers
 * it can remux. None of these involve protected media.
 *
 * Deliberately an allowlist. Every DRM code (encrypted_media_detected,
 * cdm_required, license_bound_stream, clearkey_deferred,
 * clear_segments_unavailable) is absent: a local run must never be the
 * answer to "the media is protected".
 */
export const DELEGABLE_ERROR_CODES: ReadonlySet<JobError["code"]> = new Set<JobError["code"]>([
  "dash_unsupported",
  "hls_encryption_unsupported",
  "hls_layout_unsupported",
  "output_too_large_for_browser",
  "unsupported_output",
  "no_remux_path",
  "unsupported_codec",
  "manifest_malformed",
  "missing_video_track",
  "no_variant_meets_minimum",
  "cors_blocked",
  "mixed_content_blocked",
  "engine_oom",
  "engine_job_failed",
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
  readonly env: { readonly browser: "chromium" | "firefox"; readonly userAgent: string };
  readonly onJobUpdate: (job: LocalJobView) => void;
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
  /** Start a download for a page URL. Returns the job view (phase "probing") or null when disabled. */
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
  const newId = deps.newId ?? (() => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  let pongCache: { readonly at: number; readonly value: HostPong } | null = null;

  function update(job: LocalJobView): void {
    jobs.set(job.id, job);
    deps.onJobUpdate(job);
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

  async function start(pageUrl: string, tabId: number | null): Promise<LocalJobView | null> {
    const settings = await loadLocalSettings(deps.storage);
    if (!settings.enabled || !(await hasPermission())) return null;
    if (!/^https?:\/\//i.test(pageUrl)) return null;

    const id = newId();
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
          update({ ...(jobs.get(id) ?? initial), phase: "failed", failure: { code: f.code, message: f.message } });
        },
      },
    );
    const current = jobs.get(id);
    if (current && current.phase !== "complete" && current.phase !== "failed") cancels.set(id, cancel);
    return initial;
  }

  async function startFallback(pageUrl: string, tabId: number | null): Promise<LocalJobView | null> {
    const settings = await loadLocalSettings(deps.storage);
    if (!settings.enabled || !settings.fallbackOnHotkey) return null;
    return start(pageUrl, tabId);
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
    startFallback,
    cancel: id => cancels.get(id)?.(),
  };
}
