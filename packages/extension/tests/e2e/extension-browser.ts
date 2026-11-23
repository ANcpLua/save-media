import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWorkerErrors } from "./extension-worker";

/**
 * Chromium launch options for the extension suites. The full Chromium build
 * runs MV3 extensions in its new headless mode, so a test run opens no
 * windows and takes no focus. Set SAVEMEDIA_HEADED=1 to watch the windows.
 */
export const extensionBrowser = {
  channel: "chromium",
  headless: process.env.SAVEMEDIA_HEADED !== "1",
} as const;

/** The built Chrome extension the suites load. */
export const extensionDist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-chrome");

export interface ExtensionLaunch {
  /** Names this run's profile and download folders among the temporary files. */
  readonly name: string;
  readonly baseURL?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Browser switches besides the two that load the extension. */
  readonly args?: readonly string[];
  /**
   * Switches the test runner passes to every browser by itself and that this run must not get. The runner
   * switches the back-forward cache off (--disable-back-forward-cache), so a test of a restore names it here.
   */
  readonly ignoreDefaultArgs?: readonly string[];
}

/** A browser with the built extension loaded, in a profile of its own. */
export interface ExtensionSession {
  readonly context: BrowserContext;
  readonly extensionId: string;
  /** The popup's address, at the path the built manifest gives it. */
  readonly popupUrl: string;
  /** The popup's path inside the extension, without a leading slash. */
  readonly popupPath: string;
  /** The folder the browser saves files to. */
  readonly downloadDir: string;
  /**
   * What the extension logged as an error in its service worker since the launch (collectWorkerErrors):
   * its own failures, errors nothing caught there, and those the engine document reported to it. A suite
   * empties the list after each test and expects it to have been empty.
   */
  readonly workerErrors: string[];
  /** Closes the browser and removes its profile and its download folder. */
  close(): Promise<void>;
}

interface BuiltManifest {
  manifest_version?: number;
  background?: { service_worker?: string };
  action?: { default_popup?: string };
}

/** The built manifest's service worker and popup paths, each checked to exist in the build. */
function builtPaths(): { readonly worker: string; readonly popup: string } {
  const manifestPath = resolve(extensionDist, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Chrome extension build missing at ${manifestPath}. Run \`bun run --filter @savemedia/extension build:chrome\` before Playwright E2E.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BuiltManifest;
  if (manifest.manifest_version !== 3) throw new Error(`Expected built Chrome manifest_version 3 in ${manifestPath}.`);
  const path = (field: string, value: string | undefined): string => {
    if (!value) throw new Error(`Built Chrome manifest is missing ${field}.`);
    const relative = value.replace(/^\/+/, "");
    if (!existsSync(resolve(extensionDist, relative))) throw new Error(`Built Chrome manifest ${field} points at missing file ${resolve(extensionDist, relative)}.`);
    return relative;
  };
  return { worker: path("background.service_worker", manifest.background?.service_worker), popup: path("action.default_popup", manifest.action?.default_popup) };
}

/**
 * Starts Chromium with the built extension in a new profile whose downloads
 * go, without a prompt, to a new folder, and waits for the extension's
 * service worker. The worker must be the one the built manifest names.
 */
export async function launchExtension(options: ExtensionLaunch): Promise<ExtensionSession> {
  const built = builtPaths();
  const userDataDir = mkdtempSync(resolve(tmpdir(), `savemedia-${options.name}-profile-`));
  const downloadDir = mkdtempSync(resolve(tmpdir(), `savemedia-${options.name}-downloads-`));
  let context: BrowserContext | undefined;
  const close = async (): Promise<void> => {
    await context?.close().catch(() => undefined);
    for (const dir of [userDataDir, downloadDir]) rmSync(dir, { recursive: true, force: true });
  };
  try {
    mkdirSync(resolve(userDataDir, "Default"));
    writeFileSync(resolve(userDataDir, "Default", "Preferences"), JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: false },
    }));
    context = await chromium.launchPersistentContext(userDataDir, {
      ...extensionBrowser,
      acceptDownloads: true,
      downloadsPath: downloadDir,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.viewport ? { viewport: options.viewport } : {}),
      args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`, ...(options.args ?? [])],
      ...(options.ignoreDefaultArgs ? { ignoreDefaultArgs: [...options.ignoreDefaultArgs] } : {}),
    });
    let extensionId = "";
    const workerErrors = collectWorkerErrors(context, () => extensionId);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const workerUrl = new URL(worker.url());
    extensionId = workerUrl.host;
    if (workerUrl.protocol !== "chrome-extension:" || workerUrl.pathname !== `/${built.worker}`) {
      throw new Error(`The first service worker is ${worker.url()}, not the extension's ${built.worker}.`);
    }
    return { context, extensionId, popupPath: built.popup, popupUrl: `chrome-extension://${extensionId}/${built.popup}`, downloadDir, workerErrors, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Collects what goes wrong in the extension's popup pages while a suite
 * runs: errors they throw, and with `console` also what they log as an
 * error. A test empties the list and expects it to have been empty.
 *
 * The engine document is not among them: the browser gives a test no page
 * for an offscreen document. An error nothing caught there is reported to the
 * service worker (engine/host.ts), which logs it, and is found in the
 * session's `workerErrors`.
 */
export function watchExtensionPages(session: ExtensionSession, kinds: readonly ("console" | "pageerror")[]): string[] {
  const errors: string[] = [];
  const own = `chrome-extension://${session.extensionId}/`;
  const watch = (page: Page): void => {
    if (kinds.includes("console")) {
      page.on("console", message => {
        if (message.type() === "error" && page.url().startsWith(own)) errors.push(`${page.url()}: ${message.text()}`);
      });
    }
    if (kinds.includes("pageerror")) {
      page.on("pageerror", error => {
        if (page.url().startsWith(own)) errors.push(`${page.url()}: ${error.message}`);
      });
    }
  };
  session.context.on("page", watch);
  for (const page of session.context.pages()) watch(page);
  return errors;
}
