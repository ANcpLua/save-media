#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { Builder, By } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist-firefox");
const fixtureServer = resolve(root, "tests/e2e/fixture-server.mjs");
const extensionUuid = "00000000-0000-4000-8000-000000000001";
const extensionId = "savemedia@ancplua.dev";
const ffprobe = findExecutable("ffprobe", [
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
]);

const firefoxExecutable = findFirefoxExecutable();
if (!firefoxExecutable) {
  console.error("Firefox smoke not run: Firefox executable not found. Set SAVEMEDIA_FIREFOX_EXECUTABLE to a Firefox Desktop binary.");
  process.exit(2);
}
if (!ffprobe) {
  console.error("Firefox smoke not run: ffprobe not found. Install ffmpeg/ffprobe or put ffprobe on PATH.");
  process.exit(2);
}

if (!existsSync(resolve(dist, "manifest.json")) || !existsSync(resolve(dist, "background.js"))) {
  console.error("Firefox smoke not run: dist-firefox is missing. Run `pnpm --filter @savemedia/extension build:firefox` first.");
  process.exit(2);
}

const downloadDir = mkdtempSync(join(tmpdir(), "savemedia-firefox-downloads-"));
let driver;
let server;

try {
  const port = await freePort(5175);
  server = await startFixtureServer(port);
  const baseURL = `http://127.0.0.1:${port}`;

  const options = new firefox.Options().setBinary(firefoxExecutable);
  if (process.env.SAVEMEDIA_HEADFUL !== "1") options.addArguments("-headless");
  options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [extensionId]: extensionUuid }));
  options.setPreference("browser.download.folderList", 2);
  options.setPreference("browser.download.dir", downloadDir);
  options.setPreference("browser.download.useDownloadDir", true);
  options.setPreference("browser.download.always_ask_before_handling_new_types", false);
  options.setPreference("browser.helperApps.neverAsk.saveToDisk", [
    "video/mp4",
    "video/webm",
    "video/x-matroska",
    "application/octet-stream",
  ].join(","));

  driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();

  const installedId = await driver.installAddon(dist, true);
  assert(installedId === extensionId, `expected temporary add-on id ${extensionId}, got ${installedId}`);

  await driver.get(extensionUrl("src/popup/index.html"));
  assert((await driver.getTitle()) === "savemedia", "popup page did not load");
  assert((await driver.findElement(By.css("body")).getText()).includes("savemedia"), "popup body did not render");
  const popupHandle = await driver.getWindowHandle();
  console.log("✓ Firefox loaded dist-firefox and opened the popup page");

  const command = await popupEval(async () => {
    const commands = await callbackApi(chrome.commands.getAll.bind(chrome.commands));
    return commands.find(c => c.name === "download-best") ?? null;
  });
  assert(command?.name === "download-best", "download-best command is not registered");
  assert(command.shortcut === "" || command.shortcut === "Alt+S" || command.shortcut === "⌥S",
    `unexpected Firefox command shortcut: ${JSON.stringify(command.shortcut)}`);
  console.log(`✓ Firefox exposes the download-best command${command.shortcut ? ` (${command.shortcut})` : " (shortcut unassigned by Firefox)"}`);

  await clearDownloadHistory();

  const direct = await firstDescriptor("direct", d => d.protocol === "progressive-http" && d.capabilities?.directDownload === true);
  const directName = `firefox-direct-${Date.now()}.mp4`;
  await startDescriptorDownload(direct, directName);
  const directFile = await waitForDownloadedFile(directName);
  expectPlayable(directFile, /mp4|mov/);
  console.log("✓ Firefox detected and downloaded a verified direct MP4 fixture");

  await clearDownloadHistory();
  const hls = await firstDescriptor("hls", d => d.protocol === "hls" && d.capabilities?.drmBlocked === false);
  const hlsName = `firefox-hls-${Date.now()}.mp4`;
  await startDescriptorDownload(hls, hlsName);
  const hlsFile = await waitForDownloadedFile(hlsName);
  expectPlayable(hlsFile, /mp4|mov/);
  console.log("✓ Firefox remuxed and downloaded a plain HLS VOD fixture");

  await expectFailure("dash", d => d.protocol === "dash", "dash_unsupported");
  await expectFailure("hls-aes", d => d.protocol === "hls", "hls_encryption_unsupported");
  await expectFailure("hls-live", d => d.protocol === "hls", "hls_live_unsupported");
  await expectFailure("hls-fmp4", d => d.protocol === "hls", "hls_layout_unsupported");
  console.log("✓ Firefox surfaced DASH, encrypted HLS, live HLS, and HLS fMP4/CMAF refusals");

  console.log("✓ Firefox runtime smoke passed");

  async function firstDescriptor(scenario, predicate) {
    const descriptors = await waitForDescriptors(scenario, ds => ds.some(predicate));
    return descriptors.find(predicate);
  }

  async function expectFailure(scenario, predicate, expectedCode) {
    await clearDownloadHistory();
    const descriptor = await firstDescriptor(scenario, predicate);
    const code = await startDescriptorDownloadExpectFailure(descriptor, `firefox-${scenario}-${Date.now()}.mp4`);
    assert(code === expectedCode, `${scenario} refused with ${code}, expected ${expectedCode}`);
  }

  async function waitForDescriptors(scenario, predicate) {
    const marker = `/page/${scenario}.html`;
    await openFixture(scenario);
    let last = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      last = await descriptorsForMarker(marker);
      if (predicate(last)) return last;
      await sleep(250);
    }
    throw new Error(`${scenario} did not produce expected descriptors: ${JSON.stringify(last)}`);
  }

  async function openFixture(scenario) {
    await driver.switchTo().newWindow("tab");
    await driver.get(`${baseURL}/page/${scenario}.html`);
    await driver.sleep(400);
    await driver.switchTo().window(popupHandle);
  }

  async function descriptorsForMarker(marker) {
    return popupEval(async m => {
      const tabs = await callbackApi(chrome.tabs.query.bind(chrome.tabs), {});
      const matches = tabs.filter(t => t.id && t.url?.includes(m));
      const descriptors = [];
      for (const tab of matches) {
        const response = await callbackApi(chrome.runtime.sendMessage.bind(chrome.runtime), { type: "list", tabId: tab.id });
        descriptors.push(...(response?.descriptors ?? []));
      }
      return descriptors;
    }, marker);
  }

  async function clearDownloadHistory() {
    await popupEval(async () => {
      await callbackApi(chrome.downloads.erase.bind(chrome.downloads), {});
    });
  }

  async function startDescriptorDownload(descriptor, filename) {
    await popupEval(async (d, name) => {
      const variant = bestVariant(d);
      await callbackApi(chrome.runtime.sendMessage.bind(chrome.runtime), {
        type: "download",
        streamId: d.id,
        choice: {
          outputMode: "Original",
          filename: name,
          variantId: variant?.id ?? null,
          audioRenditionId: variant?.audioRenditionId ?? null,
        },
      });
    }, descriptor, filename);
  }

  async function startDescriptorDownloadExpectFailure(descriptor, filename) {
    return popupEval(async (d, name) => {
      const variant = bestVariant(d);
      const failure = new Promise(resolve => {
        const listener = msg => {
          if (msg?.type === "job-failed" && msg.streamId === d.id) {
            chrome.runtime.onMessage.removeListener(listener);
            resolve(msg.error?.code ?? "unknown");
          }
        };
        chrome.runtime.onMessage.addListener(listener);
      });
      chrome.runtime.sendMessage({
        type: "download",
        streamId: d.id,
        choice: {
          outputMode: "Original",
          filename: name,
          variantId: variant?.id ?? null,
          audioRenditionId: variant?.audioRenditionId ?? null,
        },
      });
      return await failure;
    }, descriptor, filename);
  }

  async function waitForDownloadedFile(suffix) {
    let lastItems = [];
    for (let attempt = 0; attempt < 80; attempt++) {
      const items = await popupEval(async () => {
        return await callbackApi(chrome.downloads.search.bind(chrome.downloads), {});
      });
      lastItems = items.map(item => ({
        filename: item.filename,
        state: item.state,
        error: item.error,
        exists: item.exists,
      }));
      const hit = items.find(item => item.state === "complete" && item.filename?.endsWith(suffix));
      if (hit?.filename && existsSync(hit.filename)) return hit.filename;

      const onDisk = findDownloadedFile(downloadDir, suffix);
      if (onDisk) return onDisk;
      await sleep(500);
    }
    throw new Error(`no completed ${suffix} Firefox download; last items: ${JSON.stringify(lastItems)}`);
  }

  async function popupEval(fn, ...args) {
    await driver.switchTo().window(popupHandle);
    const result = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      const args = Array.prototype.slice.call(arguments, 0, -1);
      const fn = ${fn.toString()};
      window.callbackApi = function callbackApi(api, ...apiArgs) {
        return new Promise((resolve, reject) => {
          try {
            const maybePromise = api(...apiArgs, value => {
              const lastError = chrome.runtime?.lastError;
              if (lastError) reject(new Error(lastError.message));
              else resolve(value);
            });
            if (maybePromise && typeof maybePromise.then === "function") {
              maybePromise.then(resolve, reject);
            }
          } catch (err) {
            reject(err);
          }
        });
      };
      window.bestVariant = function bestVariant(descriptor) {
        return [...(descriptor.variants ?? [])].sort((a, b) => {
          const height = (b.height ?? 0) - (a.height ?? 0);
          if (height !== 0) return height;
          return (b.bitrate ?? 0) - (a.bitrate ?? 0);
        })[0] ?? null;
      };
      Promise.resolve(fn(...args)).then(
        value => done({ ok: true, value }),
        err => done({ ok: false, error: String(err?.message ?? err), stack: String(err?.stack ?? "") }),
      );
    `, ...args);
    if (!result?.ok) throw new Error(`${result?.error ?? "Firefox popup evaluation failed"}\n${result?.stack ?? ""}`);
    return result.value;
  }
} finally {
  if (driver) await driver.quit().catch(() => undefined);
  if (server) await stopFixtureServer(server);
  rmSync(downloadDir, { recursive: true, force: true });
}

function extensionUrl(path) {
  return `moz-extension://${extensionUuid}/${path}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findDownloadedFile(dir, suffix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findDownloadedFile(path, suffix);
      if (nested) return nested;
    } else if (entry.name.endsWith(suffix) && !entry.name.endsWith(".part") && statSync(path).size > 0) {
      return path;
    }
  }
  return null;
}

function expectPlayable(file, expectedFormat) {
  const raw = execFileSync(ffprobe, [
    "-v", "error",
    "-show_entries", "format=format_name,duration",
    "-of", "json",
    file,
  ], { encoding: "utf8" });
  const parsed = JSON.parse(raw);
  const format = parsed.format?.format_name ?? "";
  const duration = Number(parsed.format?.duration ?? 0);
  assert(expectedFormat.test(format), `${file} format ${format} did not match ${expectedFormat}`);
  assert(duration > 0, `${file} had non-positive duration ${duration}`);
}

async function freePort(preferred) {
  if (await canListen(preferred)) return preferred;
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function canListen(port) {
  return new Promise(resolveCanListen => {
    const server = net.createServer();
    server.once("error", () => resolveCanListen(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveCanListen(true));
    });
  });
}

function startFixtureServer(port) {
  return new Promise((resolveServer, reject) => {
    const child = spawn(process.execPath, [fixtureServer], {
      cwd: root,
      env: { ...process.env, SAVEMEDIA_FIXTURE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("fixture server did not start within 10s"));
      }
    }, 10_000);
    child.stdout.on("data", chunk => {
      process.stdout.write(chunk);
      if (!settled && String(chunk).includes("listening")) {
        settled = true;
        clearTimeout(timer);
        resolveServer(child);
      }
    });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    child.once("exit", code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`fixture server exited before ready with code ${code}`));
      }
    });
  });
}

function stopFixtureServer(child) {
  return new Promise(resolveStop => {
    child.once("exit", () => resolveStop());
    child.kill("SIGTERM");
    setTimeout(() => resolveStop(), 2_000).unref();
  });
}

function findFirefoxExecutable() {
  const candidates = [
    process.env.SAVEMEDIA_FIREFOX_EXECUTABLE,
    "/Applications/Firefox.app/Contents/MacOS/firefox",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const found = execFileSync("sh", ["-lc", "command -v firefox"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function findExecutable(name, candidates = []) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  try {
    const found = execFileSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}
