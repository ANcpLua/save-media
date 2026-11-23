#!/usr/bin/env node
// Real popup, native messaging, yt-dlp and ffmpeg, isolated from the user's
// cookie profiles, download archive, configuration, logs and Downloads.
import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Say what is missing before anything starts: a missing build or tool would otherwise fail deep inside the run.
if (!existsSync(join(root, "dist-chrome", "manifest.json"))) {
  console.error("smoke-native: dist-chrome is missing. Build it first: bun run --filter @savemedia/extension build:chrome");
  process.exit(2);
}
for (const [tool, flag, pkg] of [["python3", "--version", "python"], ["yt-dlp", "--version", "yt-dlp"], ["ffmpeg", "-version", "ffmpeg"], ["ffprobe", "-version", "ffmpeg"]]) {
  const probe = spawnSync(tool, [flag], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.error(`smoke-native: ${tool} not found on PATH. Install it (for example: brew install ${pkg}) and run again.`);
    process.exit(2);
  }
  if (tool === "yt-dlp") console.log(`smoke-native: yt-dlp ${probe.stdout.trim()}`);
}

const work = mkdtempSync(join(tmpdir(), "savemedia-native-smoke-"));
const fixture = fork(resolve(root, "tests/e2e/fixture-server.mjs"), [], {
  env: { ...process.env, SAVEMEDIA_FIXTURE_PORT: "0" },
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
let context;
try {
  const [ready] = await Promise.race([
    once(fixture, "message"),
    once(fixture, "exit").then(([code]) => { throw new Error(`Fixture exited with ${code}`); }),
  ]);
  const ext = join(work, "extension");
  cpSync(join(root, "dist-chrome"), ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  manifest.permissions.push("nativeMessaging");
  manifest.optional_permissions = manifest.optional_permissions.filter(p => p !== "nativeMessaging");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

  const profile = join(work, "profile");
  const hostHome = join(work, "helper-home");
  const downloads = join(hostHome, "Downloads");
  mkdirSync(downloads, { recursive: true });
  const launcher = join(work, "fixture-host");
  const helper = resolve(root, "../native-host/host.py");
  writeFileSync(launcher, `#!/usr/bin/env python3
import os, sys
os.environ.update(HOME=${JSON.stringify(hostHome)}, XDG_CONFIG_HOME=${JSON.stringify(join(hostHome, ".config"))}, XDG_STATE_HOME=${JSON.stringify(join(hostHome, ".state"))})
os.execv(sys.executable, [sys.executable, ${JSON.stringify(helper)}])
`, { mode: 0o700 });
  const config = join(work, "browser-config");
  context = await chromium.launchPersistentContext(profile, {
    // New headless mode runs the extension without opening a window. SAVEMEDIA_HEADED=1 shows it.
    channel: "chromium",
    headless: process.env.SAVEMEDIA_HEADED !== "1",
    env: { ...process.env, XDG_CONFIG_HOME: config },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--window-position=2000,2000"],
  });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  for (const base of [profile, join(config, "chromium"), join(config, "google-chrome"), join(config, "google-chrome-for-testing")]) {
    const registrations = join(base, "NativeMessagingHosts");
    mkdirSync(registrations, { recursive: true });
    writeFileSync(join(registrations, "com.savemedia.host.json"), JSON.stringify({
      name: "com.savemedia.host", type: "stdio", description: "Isolated savemedia test host", path: launcher,
      allowed_origins: [`chrome-extension://${id}/`],
    }));
  }

  const tab = await context.newPage();
  const popup = await context.newPage();
  async function showPage(path) {
    const url = ready.address + path;
    await tab.goto(url);
    const tabId = await sw.evaluate(async href => (await chrome.tabs.query({})).find(t => t.url === href)?.id, url);
    assert.ok(tabId);
    await popup.goto(`chrome-extension://${id}/src/popup/index.html?tabId=${tabId}`);
  }
  // yt-dlp can extract the local HTML video element and names the final file
  // in a dated subdirectory below Downloads.
  await showPage("/page/direct.html");
  const enable = popup.getByTestId("local-enable");
  await enable.click();
  // The checkbox reflects the persisted setting after the permission check.
  await expect(enable).toBeChecked({ timeout: 15_000 });
  const save = popup.getByTestId("local-download-page");
  const cookies = popup.getByTestId("local-cookies");
  await expect(save).toBeEnabled({ timeout: 15_000 });
  await expect(popup.getByTestId("local-status-pill")).toHaveText("Ready");
  // A browser the user picks is passed to yt-dlp as it is. This helper home has no cookie database, so yt-dlp
  // stops, and the popup says so in plain words with yt-dlp's own line under Technical details.
  await cookies.selectOption("chrome");
  await save.click();
  const refused = popup.getByTestId("local-job-failed");
  await expect(refused.getByTestId("failure-title")).toHaveText("yt-dlp could not save this page", { timeout: 30_000 });
  await expect(refused.getByTestId("failure-body")).toHaveText("yt-dlp stopped with an error.");
  await refused.getByText("Technical details", { exact: true }).click();
  await expect(refused.locator("dd").first()).toContainText(/cookie/i);
  await expect(refused.getByText("unknown", { exact: true })).toBeVisible();
  assert.deepEqual(readdirSync(downloads), []);

  await cookies.selectOption("auto");
  await save.click();
  await expect(popup.getByTestId("local-job-complete")).toBeVisible({ timeout: 45_000 });
  const paths = readdirSync(downloads, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  assert.equal(paths.length, 1);
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", paths[0]], { encoding: "utf8" });
  assert.match(probe, /video/);
  console.log(`Public fixture saved and verified: ${basename(paths[0])}`);

  await showPage("/unavailable/master.m3u8");
  await save.click();
  // The status is a technical detail: the main text says what it means.
  const busy = popup.getByTestId("local-job-failed");
  await expect(busy.getByTestId("failure-title")).toHaveText("The server is busy", { timeout: 45_000 });
  await expect(busy.getByText("522", { exact: true })).toBeHidden();
  await busy.getByText("Technical details", { exact: true }).click();
  await expect(busy.getByText("522", { exact: true })).toBeVisible();
  assert.ok(existsSync(paths[0]));
  assert.equal(readdirSync(downloads, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length, 1);
  console.log("Native smoke passed: a browser without a cookie database, an automatic save of the local fixture, a server that never answers in time.");
} finally {
  await context?.close();
  fixture.kill();
  rmSync(work, { recursive: true, force: true });
}
