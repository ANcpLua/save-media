import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "..", "dist-chrome");
const fixtureBaseURL = `http://127.0.0.1:${process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174}`;

/**
 * End-to-end classification: load the unpacked Chrome extension into a
 * persistent context, visit each fixture page, and verify the background
 * service worker classified the captured media correctly.
 *
 * **Reading extension state from tests.** The fixture pages are ordinary
 * web pages, so they cannot call chrome.runtime. The test opens the real
 * popup HTML and asks the background service worker through the same
 * chrome.runtime message path the popup uses in production.
 */

interface Descriptor {
  id: string;
  protocol: string;
  container: string;
  pageUrl: string;
  variants: Array<{ id: string; height: number | null; bitrate: number | null; audioRenditionId: string | null }>;
  drm: null | { reason: string };
  capabilities: { drmBlocked: boolean; directDownload: boolean };
}

interface ExtensionManifest {
  manifest_version?: number;
  background?: { service_worker?: string };
  action?: { default_popup?: string };
}

interface ExtensionRuntime {
  context: BrowserContext;
  extensionId: string;
  popupPath: string;
  userDataDir: string;
  consoleErrors: string[];
}

type ExtensionLaunchOptions = Pick<NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>, "acceptDownloads" | "downloadsPath">;

async function launchExtensionRuntime(options: ExtensionLaunchOptions = {}): Promise<ExtensionRuntime> {
  const manifest = readBuiltManifest();
  const userDataDir = mkdtempSync(resolve(tmpdir(), "savemedia-chrome-profile-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      baseURL: fixtureBaseURL,
      ...options,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });

    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const workerUrl = new URL(worker.url());
    const workerPath = normalizeManifestPath(manifest.background!.service_worker!);
    expect(workerUrl.protocol).toBe("chrome-extension:");
    expect(workerUrl.pathname).toBe(`/${workerPath}`);

    const runtime: ExtensionRuntime = {
      context,
      extensionId: workerUrl.host,
      popupPath: normalizeManifestPath(manifest.action!.default_popup!),
      userDataDir,
      consoleErrors: [],
    };
    context.on("page", page => captureFatalExtensionConsoleErrors(runtime, page));
    for (const page of context.pages()) captureFatalExtensionConsoleErrors(runtime, page);
    return runtime;
  } catch (error) {
    await context?.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeExtensionRuntime(runtime: ExtensionRuntime | undefined): Promise<void> {
  await runtime?.context.close().catch(() => undefined);
  if (runtime) rmSync(runtime.userDataDir, { recursive: true, force: true });
}

function readBuiltManifest(): ExtensionManifest {
  const manifestPath = resolve(dist, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Chrome extension build missing at ${manifestPath}. Run \`pnpm --filter @savemedia/extension build:chrome\` before Playwright E2E.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected built Chrome manifest_version 3 in ${manifestPath}.`);
  }
  assertBuiltManifestPath("background.service_worker", manifest.background?.service_worker);
  assertBuiltManifestPath("action.default_popup", manifest.action?.default_popup);
  return manifest;
}

function assertBuiltManifestPath(field: string, value: string | undefined): void {
  if (!value) throw new Error(`Built Chrome manifest is missing ${field}.`);
  const builtPath = resolve(dist, normalizeManifestPath(value));
  if (!existsSync(builtPath)) throw new Error(`Built Chrome manifest ${field} points at missing file ${builtPath}.`);
}

function normalizeManifestPath(value: string): string {
  return value.replace(/^\/+/, "");
}

function extensionPageUrl(runtime: ExtensionRuntime): string {
  return `chrome-extension://${runtime.extensionId}/${runtime.popupPath}`;
}

function captureFatalExtensionConsoleErrors(runtime: ExtensionRuntime, page: Page): void {
  page.on("console", message => {
    if (message.type() === "error" && page.url().startsWith(`chrome-extension://${runtime.extensionId}/`)) {
      runtime.consoleErrors.push(`${page.url()}: ${message.text()}`);
    }
  });
  page.on("pageerror", error => {
    if (page.url().startsWith(`chrome-extension://${runtime.extensionId}/`)) {
      runtime.consoleErrors.push(`${page.url()}: ${error.message}`);
    }
  });
}

function expectNoFatalExtensionConsoleErrors(runtime: ExtensionRuntime | undefined): void {
  const errors = runtime?.consoleErrors.splice(0) ?? [];
  expect(errors, "fatal console/page errors emitted by extension pages").toEqual([]);
}

test.describe("extension classifies real fixture pages", () => {
  // Both describes drive an unpacked Chromium extension via the chromium
  // module directly. The firefox playwright project must skip them so it
  // doesn't try to launch a Chromium binary it hasn't installed.
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only suite");

  let runtime: ExtensionRuntime | undefined;
  let context: BrowserContext | undefined;
  let probe: Page | undefined;
  let downloadDir: string | undefined;

  test.beforeAll(async ({ browserName }) => {
    // The describe-level test.skip() skips individual tests but Playwright
    // still runs the hooks; guard the chromium launch so the firefox
    // project doesn't try to spawn a binary it never installed.
    if (browserName !== "chromium") return;
    downloadDir = mkdtempSync(resolve(tmpdir(), "savemedia-downloads-"));
    runtime = await launchExtensionRuntime({ acceptDownloads: true, downloadsPath: downloadDir });
    context = runtime.context;
    probe = await context.newPage();
    await probe.goto(extensionPageUrl(runtime));
    await expect(probe.locator("header")).toContainText("savemedia");
  });

  test.afterEach(() => {
    expectNoFatalExtensionConsoleErrors(runtime);
  });

  test.afterAll(async () => {
    await probe?.close();
    await closeExtensionRuntime(runtime);
    if (downloadDir) rmSync(downloadDir, { recursive: true, force: true });
  });

  async function descriptorsForUrlContaining(marker: string): Promise<Descriptor[]> {
    return await probe!.evaluate(async (m: string) => {
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter(t => t.id && t.url?.includes(m));
      const descriptors: Descriptor[] = [];
      for (const tab of matches) {
        const response = await new Promise<{ descriptors?: Descriptor[] } | undefined>(resolve =>
          chrome.runtime.sendMessage({ type: "list", tabId: tab.id }, resolve),
        );
        descriptors.push(...(response?.descriptors ?? []));
      }
      return descriptors;
    }, marker);
  }

  async function waitForDescriptors(scenario: string, predicate: (d: Descriptor[]) => boolean): Promise<Descriptor[]> {
    const marker = `/page/${scenario}.html`;
    const page = await context!.newPage();
    try {
      await page.goto(marker);
      await page.waitForLoadState("networkidle");
      for (let attempt = 0; attempt < 20; attempt++) {
        const descriptors = await descriptorsForUrlContaining(marker);
        if (predicate(descriptors)) return descriptors;
        await page.waitForTimeout(250);
      }
      return descriptorsForUrlContaining(marker);
    } finally {
      await page.close();
    }
  }

  async function openFixtureAndWait(scenario: string, predicate: (d: Descriptor[]) => boolean): Promise<Page> {
    const marker = `/page/${scenario}.html`;
    const page = await context!.newPage();
    await page.bringToFront();
    await page.goto(marker);
    await page.waitForLoadState("networkidle");
    for (let attempt = 0; attempt < 30; attempt++) {
      if (predicate(await descriptorsForUrlContaining(marker))) return page;
      await page.waitForTimeout(250);
    }
    throw new Error(`${scenario} did not produce expected descriptors: ${JSON.stringify(await descriptorsForUrlContaining(marker))}`);
  }

  async function clearDownloadHistory(): Promise<void> {
    await probe!.evaluate(async () => {
      await chrome.downloads.erase({});
    });
  }

  async function waitForCompletedDownload(page: Page, suffix: string): Promise<string> {
    let lastItems: unknown[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await probe!.evaluate(async (s: string) => {
        const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 20 });
        return {
          items: items.map(item => ({
            filename: item.filename,
            state: item.state,
            error: item.error,
            url: item.url,
            exists: item.exists,
          })),
          file: (
            items.find(item => item.state === "complete" && item.filename.endsWith(s))
            ?? items.find(item => item.state === "complete" && item.exists)
          )?.filename ?? null,
        };
      }, suffix);
      lastItems = result.items;
      if (result.file && existsSync(result.file)) return result.file;
      await page.waitForTimeout(500);
    }
    throw new Error(`no completed ${suffix} download visible in chrome.downloads; last items: ${JSON.stringify(lastItems)}`);
  }

  function expectPlayable(file: string, expectedFormat: RegExp): void {
    const raw = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=format_name,duration",
      "-of", "json",
      file,
    ], { encoding: "utf8" });
    const parsed = JSON.parse(raw) as { format?: { format_name?: string; duration?: string } };
    expect(parsed.format?.format_name ?? "").toMatch(expectedFormat);
    expect(Number(parsed.format?.duration ?? 0)).toBeGreaterThan(0);
  }

  async function startDescriptorDownload(descriptor: Descriptor, filename: string): Promise<void> {
    const variant = [...(descriptor.variants ?? [])].sort((a, b) => {
      const height = (b.height ?? 0) - (a.height ?? 0);
      if (height !== 0) return height;
      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    })[0];
    await probe!.evaluate(async ({ streamId, name, variantId, audioRenditionId }) => {
      await new Promise(resolve => chrome.runtime.sendMessage({
        type: "download",
        streamId,
        choice: {
          outputMode: "Original",
          filename: name,
          variantId,
          audioRenditionId,
        },
      }, resolve));
    }, {
      streamId: descriptor.id,
      name: filename,
      variantId: variant?.id ?? null,
      audioRenditionId: variant?.audioRenditionId ?? null,
    });
  }

  async function startDescriptorDownloadExpectFailure(descriptor: Descriptor, filename: string): Promise<string> {
    const variant = [...(descriptor.variants ?? [])].sort((a, b) => {
      const height = (b.height ?? 0) - (a.height ?? 0);
      if (height !== 0) return height;
      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    })[0];
    return await probe!.evaluate(async ({ streamId, name, variantId, audioRenditionId }) => {
      const failure = new Promise<string>(resolve => {
        const listener = (msg: unknown) => {
          const m = msg as { type?: string; streamId?: string; error?: { code?: string } };
          if (m.type === "job-failed" && m.streamId === streamId) {
            chrome.runtime.onMessage.removeListener(listener);
            resolve(m.error?.code ?? "unknown");
          }
        };
        chrome.runtime.onMessage.addListener(listener);
      });
      chrome.runtime.sendMessage({
        type: "download",
        streamId,
        choice: {
          outputMode: "Original",
          filename: name,
          variantId,
          audioRenditionId,
        },
      });
      return await failure;
    }, {
      streamId: descriptor.id,
      name: filename,
      variantId: variant?.id ?? null,
      audioRenditionId: variant?.audioRenditionId ?? null,
    });
  }

  test("direct MP4 fixture produces a progressive-http descriptor with directDownload", async () => {
    const descriptors = await waitForDescriptors("direct", ds => ds.some(d => d.protocol === "progressive-http"));
    const direct = descriptors.find(d => d.protocol === "progressive-http");
    expect(direct, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(direct?.capabilities.directDownload).toBe(true);
    expect(direct?.capabilities.drmBlocked).toBe(false);
  });

  test("HLS master fixture produces an hls descriptor", async () => {
    const descriptors = await waitForDescriptors("hls", ds => ds.some(d => d.protocol === "hls"));
    const hls = descriptors.find(d => d.protocol === "hls");
    expect(hls, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(hls?.capabilities.drmBlocked).toBe(false);
  });

  test("HLS fMP4 fixture ignores init/fragment requests as standalone videos", async () => {
    const descriptors = await waitForDescriptors("hls-fmp4", ds => ds.some(d => d.protocol === "hls"));
    const hls = descriptors.find(d => d.protocol === "hls");
    expect(hls, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(descriptors.filter(d => d.protocol === "progressive-http")).toHaveLength(0);
  });

  test("HLS fMP4 .mp4-named fragments are not surfaced as standalone videos", async () => {
    const descriptors = await waitForDescriptors("hls-fmp4-mp4", ds => ds.some(d => d.protocol === "hls"));
    const hls = descriptors.find(d => d.protocol === "hls");
    expect(hls, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(descriptors.filter(d => d.protocol === "progressive-http")).toHaveLength(0);
  });

  test("DASH MPD fixture produces a dash descriptor", async () => {
    const descriptors = await waitForDescriptors("dash", ds => ds.some(d => d.protocol === "dash"));
    const dash = descriptors.find(d => d.protocol === "dash");
    expect(dash, `got ${JSON.stringify(descriptors)}`).toBeDefined();
  });

  test("widevine MPD is classified as DRM-blocked with reason cdm_required", async () => {
    const descriptors = await waitForDescriptors("widevine", ds => ds.some(d => d.drm?.reason === "cdm_required"));
    const drm = descriptors.find(d => d.drm?.reason === "cdm_required");
    expect(drm, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(drm?.capabilities.drmBlocked).toBe(true);
  });

  test("clearkey MPD surfaces clearkey_deferred (distinct from cdm_required)", async () => {
    const descriptors = await waitForDescriptors("clearkey", ds => ds.some(d => d.drm?.reason === "clearkey_deferred"));
    const ck = descriptors.find(d => d.drm?.reason === "clearkey_deferred");
    expect(ck, `got ${JSON.stringify(descriptors)}`).toBeDefined();
    expect(ck?.capabilities.drmBlocked).toBe(true);
  });

  test("negative page produces zero descriptors (no .jpg/.css/.js mis-classified as media)", async () => {
    const marker = "/page/negative.html";
    const page = await context!.newPage();
    try {
      await page.goto(marker);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1_500);
      const descriptors = await descriptorsForUrlContaining(marker);
      expect(descriptors.filter(d => d.pageUrl.includes("/page/negative.html"))).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  test("content bridge discovers embedded HLS URLs before playback starts", async () => {
    const page = await context!.newPage();
    try {
      await page.goto("/page/embedded-hls.html");
      await page.waitForLoadState("networkidle");

      const response = await probe!.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const fixture = tabs.find(t => t.url?.includes("/page/embedded-hls.html"));
        if (!fixture?.id) return { ok: false, urls: [] as string[] };
        const discovered = await new Promise<{ urls?: string[] } | undefined>(resolve =>
          chrome.tabs.sendMessage(fixture.id!, { type: "discover-page-media" }, resp => resolve(resp)),
        );
        return { ok: true, urls: discovered?.urls ?? [] };
      });

      expect(response.ok).toBe(true);
      expect(response.urls.some(u => u.endsWith("/hls/master.m3u8"))).toBe(true);
      expect(response.urls.some(u => u.endsWith("/hls-fmp4/master.m3u8"))).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("download pipeline saves direct MP4 as a playable MP4", async () => {
    await clearDownloadHistory();
    const page = await openFixtureAndWait("direct", ds => ds.some(d => d.protocol === "progressive-http"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/direct.html")).find(d => d.protocol === "progressive-http");
      expect(descriptor).toBeDefined();
      await startDescriptorDownload(descriptor!, "e2e-direct.mp4");
      const file = await waitForCompletedDownload(page, "e2e-direct.mp4");
      expectPlayable(file, /mp4|mov/);
    } finally {
      await page.close();
    }
  });

  test("download pipeline saves HLS MPEG-TS as a playable remuxed MP4", async () => {
    await clearDownloadHistory();
    const page = await openFixtureAndWait("hls", ds => ds.some(d => d.protocol === "hls"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/hls.html")).find(d => d.protocol === "hls");
      expect(descriptor).toBeDefined();
      await startDescriptorDownload(descriptor!, "e2e-hls.mp4");
      const file = await waitForCompletedDownload(page, "e2e-hls.mp4");
      expectPlayable(file, /mp4|mov/);
    } finally {
      await page.close();
    }
  });

  test("download pipeline refuses HLS AES-128 instead of writing decrypted or encrypted bytes", async () => {
    await clearDownloadHistory();
    const page = await openFixtureAndWait("hls-aes", ds => ds.some(d => d.protocol === "hls"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/hls-aes.html")).find(d => d.protocol === "hls");
      expect(descriptor).toBeDefined();
      await expect(startDescriptorDownloadExpectFailure(descriptor!, "e2e-hls-aes.mp4"))
        .resolves.toBe("hls_encryption_unsupported");
    } finally {
      await page.close();
    }
  });

  test("download pipeline saves clear HLS fMP4/CMAF as a playable MP4", async () => {
    await clearDownloadHistory();
    const page = await openFixtureAndWait("hls-fmp4", ds => ds.some(d => d.protocol === "hls"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/hls-fmp4.html")).find(d => d.protocol === "hls");
      expect(descriptor).toBeDefined();
      await startDescriptorDownload(descriptor!, "e2e-hls-fmp4.mp4");
      const file = await waitForCompletedDownload(page, "e2e-hls-fmp4.mp4");
      expectPlayable(file, /mp4|mov/);
    } finally {
      await page.close();
    }
  });

  test("Alt+S on the page starts the best HLS download", async () => {
    await clearDownloadHistory();
    const page = await openFixtureAndWait("hls-fmp4-mp4", ds => ds.some(d => d.protocol === "hls"));
    try {
      await page.bringToFront();
      await page.keyboard.press("Alt+KeyS");
      const file = await waitForCompletedDownload(page, ".mp4");
      expectPlayable(file, /mp4|mov/);
    } finally {
      await page.close();
    }
  });

  test("download pipeline refuses HLS live/sliding-window playlists", async () => {
    await clearDownloadHistory();
    const page = await openFixtureAndWait("hls-live", ds => ds.some(d => d.protocol === "hls"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/hls-live.html")).find(d => d.protocol === "hls");
      expect(descriptor).toBeDefined();
      await expect(startDescriptorDownloadExpectFailure(descriptor!, "e2e-hls-live.mp4"))
        .resolves.toBe("hls_live_unsupported");
    } finally {
      await page.close();
    }
  });

  test("download pipeline refuses DASH instead of attempting a partial MPD assembly", async () => {
    await clearDownloadHistory();
    const page = await openFixtureAndWait("dash", ds => ds.some(d => d.protocol === "dash"));
    try {
      const descriptor = (await descriptorsForUrlContaining("/page/dash.html")).find(d => d.protocol === "dash");
      expect(descriptor).toBeDefined();
      await expect(startDescriptorDownloadExpectFailure(descriptor!, "e2e-dash.mp4"))
        .resolves.toBe("dash_unsupported");
    } finally {
      await page.close();
    }
  });
});

test.describe("popup HTML round-trips chrome.runtime messaging", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only suite");

  let runtime: ExtensionRuntime | undefined;
  let context: BrowserContext | undefined;

  test.beforeAll(async ({ browserName }) => {
    if (browserName !== "chromium") return;
    runtime = await launchExtensionRuntime();
    context = runtime.context;
  });

  test.afterEach(() => {
    expectNoFatalExtensionConsoleErrors(runtime);
  });

  test.afterAll(async () => {
    await closeExtensionRuntime(runtime);
  });

  test("popup loads + sendMessage('list') from popup actually reaches the SW", async () => {
    // First populate state by visiting a fixture in a separate tab.
    const fixturePage = await context!.newPage();
    await fixturePage.goto("/page/direct.html");
    await fixturePage.waitForLoadState("networkidle");
    await fixturePage.waitForTimeout(800);

    const popup = await context!.newPage();
    try {
      await popup.goto(extensionPageUrl(runtime!));
      expect(new URL(popup.url()).pathname).toBe(`/${runtime!.popupPath}`);
      await expect(popup.locator("header")).toContainText("savemedia");
      // Within the popup context, chrome.runtime.sendMessage DOES round-trip
      // to the SW listener. Probe the list response for the fixture tab.
      const popupSeen = await popup.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const fixture = tabs.find(t => t.url?.includes("/page/direct.html"));
        if (!fixture?.id) return { ok: false, reason: "no fixture tab visible from popup" };
        const response: { descriptors?: unknown[] } | undefined = await new Promise(r =>
          chrome.runtime.sendMessage({ type: "list", tabId: fixture.id }, (resp: { descriptors?: unknown[] } | undefined) => r(resp)),
        );
        return { ok: true, descriptorCount: response?.descriptors?.length ?? 0, tabId: fixture.id };
      });
      expect(popupSeen).toMatchObject({ ok: true });
      if (popupSeen.ok) {
        expect(popupSeen.descriptorCount).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await popup.close();
      await fixturePage.close();
    }
  });

  test("Chrome registers Alt+S for the best-download command", async () => {
    const popup = await context!.newPage();
    try {
      await popup.goto(extensionPageUrl(runtime!));
      const command = await popup.evaluate(async () => {
        const commands = await chrome.commands.getAll();
        return commands.find(c => c.name === "download-best") ?? null;
      });
      expect(command?.name).toBe("download-best");
      expect(["Alt+S", "⌥S"]).toContain(command?.shortcut);
    } finally {
      await popup.close();
    }
  });
});
