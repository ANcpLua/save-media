import { describe, expect, it, vi } from "vitest";
import { createLocalDownloader, DELEGABLE_ERROR_CODES, isDelegableError } from "../../../src/native/local-downloader";
import type { NativeHostClient, DownloadHandlers } from "../../../src/native/host-client";
import { LOCAL_SETTINGS_KEY, resolveCookieBrowser, parseLocalSettings, type StorageLike } from "../../../src/native/settings";

function memoryStorage(initial: Record<string, unknown> = {}): StorageLike & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: async key => ({ [key]: data[key] }),
    set: async items => { Object.assign(data, items); },
  };
}

function fakeClient() {
  const handlers: DownloadHandlers[] = [];
  const cancel = vi.fn();
  const client: NativeHostClient & { handlers: DownloadHandlers[]; cancel: typeof cancel } = {
    handlers,
    cancel,
    ping: vi.fn(async () => ({
      type: "pong" as const, hostVersion: "1.0.0", protocolVersion: 1,
      ytdlp: { found: true, version: "x", path: "/x" }, ffmpeg: { found: true, version: "y", path: "/y" }, outputDir: "/dl",
    })),
    download: vi.fn((_req, h) => { handlers.push(h); return cancel; }),
  };
  return client;
}

function build(opts: { enabled?: boolean; fallback?: boolean; permission?: boolean } = {}) {
  const storage = memoryStorage({ [LOCAL_SETTINGS_KEY]: { enabled: opts.enabled ?? true, quality: "720", cookies: "auto", fallbackOnHotkey: opts.fallback ?? true } });
  const client = fakeClient();
  const permissions = {
    contains: vi.fn(async () => opts.permission ?? true),
  };
  const updates: unknown[] = [];
  const ld = createLocalDownloader({
    client, storage, permissions,
    env: { browser: "chromium", userAgent: "Mozilla/5.0 Chrome/140 Edg/140" },
    onJobUpdate: job => updates.push(job),
    newId: () => "job-1",
  });
  return { ld, client, storage, permissions, updates };
}

describe("delegation allowlist", () => {
  it("contains only browser-engine limitations, never protected-media codes", () => {
    for (const code of ["encrypted_media_detected", "cdm_required", "license_bound_stream", "clearkey_deferred", "clear_segments_unavailable", "access_denied", "user_cancelled"] as const) {
      expect(DELEGABLE_ERROR_CODES.has(code)).toBe(false);
    }
    expect(isDelegableError({ code: "dash_unsupported", severity: "terminal", manifestUrl: "u" })).toBe(true);
    expect(isDelegableError({ code: "cdm_required", severity: "terminal", keySystem: "com.widevine.alpha" })).toBe(false);
  });
});

describe("local downloader", () => {
  it("starts a job with the stored quality and the resolved browser cookie source", async () => {
    const { ld, client } = build();
    const job = await ld.start("https://example.com/watch", 7);
    expect(job).toMatchObject({ id: "job-1", phase: "probing", tabId: 7 });
    expect(client.download).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1", pageUrl: "https://example.com/watch", quality: "720", cookiesFromBrowser: "edge" }),
      expect.anything(),
    );
  });

  it("refuses to start when disabled, when the permission is missing, or for non-http URLs", async () => {
    expect(await build({ enabled: false }).ld.start("https://example.com/", null)).toBeNull();
    expect(await build({ permission: false }).ld.start("https://example.com/", null)).toBeNull();
    expect(await build().ld.start("file:///etc/passwd", null)).toBeNull();
    expect(await build().ld.start("chrome://extensions", null)).toBeNull();
  });

  it("startFallback honours the fallbackOnHotkey setting", async () => {
    expect(await build({ fallback: false }).ld.startFallback("https://example.com/", 1)).toBeNull();
    expect(await build({ fallback: true }).ld.startFallback("https://example.com/", 1)).not.toBeNull();
  });

  it("publishes progress, completion and failure as job views", async () => {
    const { ld, client, updates } = build();
    await ld.start("https://example.com/watch", 1);
    const h = client.handlers[0]!;
    h.onProgress({ type: "progress", id: "job-1", phase: "downloading", downloadedBytes: 50, totalBytes: 100, percent: 50, speedBytesPerSec: 10, etaSeconds: 5 });
    h.onComplete({ type: "complete", id: "job-1", filename: "clip.mp4", path: "/dl/clip.mp4", bytes: 100 });
    expect(updates.at(-2)).toMatchObject({ phase: "downloading", percent: 50 });
    expect(updates.at(-1)).toMatchObject({ phase: "complete", filename: "clip.mp4", percent: 100 });
    expect((await ld.status()).jobs[0]).toMatchObject({ phase: "complete" });

    const second = build();
    await second.ld.start("https://example.com/watch", 1);
    second.client.handlers[0]!.onFailed({ type: "failed", id: "job-1", code: "drm_protected", message: "DRM" });
    expect(second.updates.at(-1)).toMatchObject({ phase: "failed", failure: { code: "drm_protected" } });
  });

  it("cancel forwards to the running job", async () => {
    const { ld, client } = build();
    await ld.start("https://example.com/watch", 1);
    ld.cancel("job-1");
    expect(client.cancel).toHaveBeenCalled();
  });

  it("enabling without the permission stays off; with it, turns on", async () => {
    const storage = memoryStorage();
    const permissions = { contains: vi.fn(async () => false) };
    const ld = createLocalDownloader({ client: fakeClient(), storage, permissions, env: { browser: "firefox", userAgent: "" }, onJobUpdate: () => undefined });
    expect((await ld.updateSettings({ enabled: true })).enabled).toBe(false);

    permissions.contains.mockResolvedValue(true);
    expect((await ld.updateSettings({ enabled: true })).enabled).toBe(true);
  });

  it("status reports host null without the permission and never pings", async () => {
    const { ld, client } = build({ permission: false });
    const s = await ld.status();
    expect(s.host).toBeNull();
    expect(s.permissionGranted).toBe(false);
    expect(client.ping).not.toHaveBeenCalled();
  });
});

describe("settings", () => {
  it("parses unknown or partial values to safe defaults", () => {
    expect(parseLocalSettings(undefined)).toEqual({ enabled: false, quality: "best", cookies: "auto", fallbackOnHotkey: true });
    expect(parseLocalSettings({ enabled: "yes", quality: "4k", cookies: "safari" })).toEqual({ enabled: false, quality: "best", cookies: "auto", fallbackOnHotkey: true });
    expect(parseLocalSettings({ enabled: true, quality: "480", cookies: "none", fallbackOnHotkey: false })).toEqual({ enabled: true, quality: "480", cookies: "none", fallbackOnHotkey: false });
  });

  it("resolves the auto cookie source from the running browser", () => {
    expect(resolveCookieBrowser("auto", { browser: "firefox", userAgent: "" })).toBe("firefox");
    expect(resolveCookieBrowser("auto", { browser: "chromium", userAgent: "Chrome/140 Edg/140" })).toBe("edge");
    expect(resolveCookieBrowser("auto", { browser: "chromium", userAgent: "Chrome/140 Safari/537" })).toBe("chrome");
    expect(resolveCookieBrowser("auto", { browser: "chromium", userAgent: "Other" })).toBe("chromium");
    expect(resolveCookieBrowser("none", { browser: "chromium", userAgent: "Chrome/140" })).toBeNull();
    expect(resolveCookieBrowser("brave", { browser: "chromium", userAgent: "Chrome/140" })).toBe("brave");
  });
});
