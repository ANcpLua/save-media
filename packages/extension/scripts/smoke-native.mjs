#!/usr/bin/env node
// Local downloader smoke test: built Chrome extension + the real native host
// in packages/native-host + the user's own yt-dlp, against the local fixture
// server. The optional nativeMessaging permission is pre-granted in a test
// copy of the manifest because a permission prompt cannot be accepted
// programmatically. The host manifest is written only into the temporary
// browser profile (Chromium resolves user-level hosts under
// <user-data-dir>/NativeMessagingHosts when --user-data-dir is set), so
// nothing outside the temp profile and ~/Downloads is touched; the
// downloaded fixture file is removed at the end.
import { chromium } from "@playwright/test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = resolve(root, "dist-chrome");
const hostPy = resolve(root, "../native-host/host.py");
const ffprobe = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"].find(existsSync) ?? "ffprobe";

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("Native smoke not run: dist-chrome missing. Run `pnpm build:chrome` first.");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "savemedia-native-smoke-"));
const testExt = join(work, "ext");
cpSync(dist, testExt, { recursive: true });
const manifest = JSON.parse(readFileSync(join(testExt, "manifest.json"), "utf8"));
manifest.permissions = [...new Set([...manifest.permissions, "nativeMessaging"])];
delete manifest.optional_permissions;
writeFileSync(join(testExt, "manifest.json"), JSON.stringify(manifest, null, 2));

const port = 5174;
const fixture = spawn(process.execPath, [resolve(root, "tests/e2e/fixture-server.mjs")], {
  env: { ...process.env, SAVEMEDIA_FIXTURE_PORT: String(port) },
  stdio: "ignore",
});
await new Promise(r => setTimeout(r, 800));

const userDataDir = join(work, "profile");
mkdirSync(userDataDir, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${testExt}`, `--load-extension=${testExt}`, "--window-size=800,600", "--window-position=2000,2000"],
});
let ok = false;
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extensionId = new URL(sw.url()).host;

  mkdirSync(join(userDataDir, "NativeMessagingHosts"), { recursive: true });
  writeFileSync(join(userDataDir, "NativeMessagingHosts/com.savemedia.host.json"), JSON.stringify({
    name: "com.savemedia.host",
    description: "savemedia local downloader host (smoke)",
    path: hostPy,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }));

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  const result = await page.evaluate(async fixtureUrl => {
    const send = msg => new Promise(res => chrome.runtime.sendMessage(msg, r => res(r ?? null)));
    const events = [];
    chrome.runtime.onMessage.addListener(m => { if (m && m.type === "local-job") events.push(m.job); });
    const status = await send({ type: "local-settings", patch: { enabled: true, cookies: "none", quality: "best" } });
    await send({ type: "local-download", tabId: null, pageUrl: fixtureUrl });
    const deadline = Date.now() + 60_000;
    let final = null;
    while (Date.now() < deadline && !final) {
      final = events.find(j => j.phase === "complete" || j.phase === "failed") ?? null;
      if (!final) await new Promise(r => setTimeout(r, 200));
    }
    return { host: status?.host, phases: events.map(j => j.phase), final };
  }, `http://127.0.0.1:${port}/direct/clip.mp4`);

  console.log("host:", result.host ? `yt-dlp ${result.host.ytdlp.version}, ffmpeg ${result.host.ffmpeg.version}` : "unreachable");
  console.log("phases:", result.phases.join(" -> "));
  if (result.final?.phase === "complete" && result.host) {
    const path = join(result.host.outputDir, result.final.filename);
    if (existsSync(path)) {
      const size = statSync(path).size;
      const probe = execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", path], { encoding: "utf8" }).trim();
      console.log(`saved ${path} (${size} bytes, ${probe})`);
      ok = size > 0 && probe.includes("mp4");
      rmSync(path);
    } else {
      console.log("reported complete but file missing:", path);
    }
  } else if (result.final?.failure) {
    console.log("failed:", result.final.failure.code, result.final.failure.message);
  }
} finally {
  await context.close();
  fixture.kill();
  rmSync(work, { recursive: true, force: true });
}
console.log(ok ? "native smoke: OK" : "native smoke: FAILED");
process.exit(ok ? 0 : 1);
