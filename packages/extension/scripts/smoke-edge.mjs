#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist-chrome");
const fixtureServer = resolve(root, "tests/e2e/fixture-server.mjs");
const ffprobe = findExecutable("ffprobe", [
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
]);

const edgeExecutable = findEdgeExecutable();
if (!edgeExecutable) {
  console.error([
    "Edge smoke not run: Microsoft Edge executable not found.",
    "Install Microsoft Edge or set SAVEMEDIA_EDGE_EXECUTABLE to the Edge binary, then run:",
    "  pnpm --filter @savemedia/extension smoke:edge",
    "On macOS the expected binary is:",
    "  /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].join("\n"));
  process.exit(2);
}

if (!existsSync(resolve(dist, "manifest.json")) || !existsSync(resolve(dist, "background.js"))) {
  console.error("Edge smoke not run: dist-chrome is missing. Run `pnpm --filter @savemedia/extension build:chrome` first.");
  process.exit(2);
}
if (!ffprobe) {
  console.error("Edge smoke not run: ffprobe not found. Install ffmpeg/ffprobe or put ffprobe on PATH.");
  process.exit(2);
}

const userDataDir = mkdtempSync(join(tmpdir(), "savemedia-edge-profile-"));
const downloadDir = mkdtempSync(join(tmpdir(), "savemedia-edge-downloads-"));
let context;
let server;

try {
  const port = await freePort(5176);
  server = await startFixtureServer(port);
  const baseURL = `http://127.0.0.1:${port}`;

  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: edgeExecutable,
    headless: false,
    acceptDownloads: true,
    downloadsPath: downloadDir,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
  });

  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  const title = await probe.title();
  assert(title === "savemedia", `Edge popup did not load, title was ${JSON.stringify(title)}`);
  console.log("✓ Edge loaded dist-chrome and opened the popup page");

  const command = await probe.evaluate(async () => {
    const commands = await chrome.commands.getAll();
    return commands.find(c => c.name === "download-best") ?? null;
  });
  assert(command?.name === "download-best", "download-best command is not registered in Edge");
  assert(["Alt+S", "⌥S", ""].includes(command.shortcut ?? ""), `unexpected Edge command shortcut: ${command.shortcut}`);
  console.log(`✓ Edge exposes the download-best command${command.shortcut ? ` (${command.shortcut})` : ""}`);

  await clearDownloadHistory(probe);
  const direct = await firstDescriptor(context, probe, baseURL, "direct", d => d.protocol === "progressive-http" && d.capabilities?.directDownload === true);
  const directName = `edge-direct-${Date.now()}.mp4`;
  await startDescriptorDownload(probe, direct, directName);
  const directFile = await waitForDownloadedFile(probe, directName);
  expectPlayable(directFile, /mp4|mov/);
  console.log("✓ Edge detected and downloaded a verified direct MP4 fixture");

  await clearDownloadHistory(probe);
  const hls = await firstDescriptor(context, probe, baseURL, "hls", d => d.protocol === "hls" && d.capabilities?.drmBlocked === false);
  const hlsName = `edge-hls-${Date.now()}.mp4`;
  await startDescriptorDownload(probe, hls, hlsName);
  const hlsFile = await waitForDownloadedFile(probe, hlsName);
  expectPlayable(hlsFile, /mp4|mov/);
  console.log("✓ Edge remuxed and downloaded a plain HLS VOD fixture");

  await expectFailure(context, probe, baseURL, "dash", d => d.protocol === "dash", "dash_unsupported");
  await expectFailure(context, probe, baseURL, "hls-aes", d => d.protocol === "hls", "hls_encryption_unsupported");
  await expectFailure(context, probe, baseURL, "hls-live", d => d.protocol === "hls", "hls_live_unsupported");
  await expectFailure(context, probe, baseURL, "hls-fmp4", d => d.protocol === "hls", "hls_layout_unsupported");
  console.log("✓ Edge surfaced DASH, encrypted HLS, live HLS, and HLS fMP4/CMAF refusals");

  console.log("✓ Edge runtime smoke passed");
} finally {
  if (context) await context.close().catch(() => undefined);
  if (server) await stopFixtureServer(server);
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(downloadDir, { recursive: true, force: true });
}

async function firstDescriptor(context, probe, baseURL, scenario, predicate) {
  const descriptors = await waitForDescriptors(context, probe, baseURL, scenario, ds => ds.some(predicate));
  return descriptors.find(predicate);
}

async function expectFailure(context, probe, baseURL, scenario, predicate, expectedCode) {
  await clearDownloadHistory(probe);
  const descriptor = await firstDescriptor(context, probe, baseURL, scenario, predicate);
  const code = await startDescriptorDownloadExpectFailure(probe, descriptor, `edge-${scenario}-${Date.now()}.mp4`);
  assert(code === expectedCode, `${scenario} refused with ${code}, expected ${expectedCode}`);
}

async function waitForDescriptors(context, probe, baseURL, scenario, predicate) {
  const marker = `/page/${scenario}.html`;
  const page = await context.newPage();
  await page.goto(`${baseURL}${marker}`);
  await page.waitForLoadState("networkidle");
  let last = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    last = await descriptorsForMarker(probe, marker);
    if (predicate(last)) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`${scenario} did not produce expected descriptors: ${JSON.stringify(last)}`);
}

async function descriptorsForMarker(probe, marker) {
  return await probe.evaluate(async m => {
    const tabs = await chrome.tabs.query({});
    const matches = tabs.filter(t => t.id && t.url?.includes(m));
    const descriptors = [];
    for (const tab of matches) {
      const response = await new Promise(resolve => chrome.runtime.sendMessage({ type: "list", tabId: tab.id }, resolve));
      descriptors.push(...(response?.descriptors ?? []));
    }
    return descriptors;
  }, marker);
}

async function clearDownloadHistory(probe) {
  await probe.evaluate(async () => chrome.downloads.erase({}));
}

async function waitForDownloadedFile(probe, suffix) {
  let lastItems = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    const items = await probe.evaluate(async () => {
      return await chrome.downloads.search({});
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
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`no completed ${suffix} Edge download; last items: ${JSON.stringify(lastItems)}`);
}

function findDownloadedFile(dir, suffix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findDownloadedFile(path, suffix);
      if (nested) return nested;
    } else if (entry.name.endsWith(suffix) && !entry.name.endsWith(".crdownload") && statSync(path).size > 0) {
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

async function startDescriptorDownload(probe, descriptor, filename) {
  await probe.evaluate(async ({ d, name }) => {
    const variant = bestVariant(d);
    await new Promise(resolve => chrome.runtime.sendMessage({
      type: "download",
      streamId: d.id,
      choice: {
        outputMode: "Original",
        filename: name,
        variantId: variant?.id ?? null,
        audioRenditionId: variant?.audioRenditionId ?? null,
      },
    }, resolve));

    function bestVariant(descriptor) {
      return [...(descriptor.variants ?? [])].sort((a, b) => {
        const height = (b.height ?? 0) - (a.height ?? 0);
        if (height !== 0) return height;
        return (b.bitrate ?? 0) - (a.bitrate ?? 0);
      })[0] ?? null;
    }
  }, { d: descriptor, name: filename });
}

async function startDescriptorDownloadExpectFailure(probe, descriptor, filename) {
  return await probe.evaluate(async ({ d, name }) => {
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

    function bestVariant(descriptor) {
      return [...(descriptor.variants ?? [])].sort((a, b) => {
        const height = (b.height ?? 0) - (a.height ?? 0);
        if (height !== 0) return height;
        return (b.bitrate ?? 0) - (a.bitrate ?? 0);
      })[0] ?? null;
    }
  }, { d: descriptor, name: filename });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function findEdgeExecutable() {
  const candidates = [
    process.env.SAVEMEDIA_EDGE_EXECUTABLE,
    process.env.CHROME_PATH?.includes("Edge") ? process.env.CHROME_PATH : null,
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["microsoft-edge", "microsoft-edge-stable", "msedge"]) {
    try {
      const found = execFileSync("sh", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      // Keep looking.
    }
  }
  return null;
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
