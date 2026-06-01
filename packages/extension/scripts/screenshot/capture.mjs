#!/usr/bin/env node
// Build the screenshot harness, then drive headless Chromium over each scene
// and write exact 1280x800 PNGs into store-assets/screenshots/.
//
//   node scripts/screenshot/capture.mjs
//
// The harness mounts the real popup <App/>, so these PNGs always depict the
// shipping UI. Output filenames match the existing store-listing slots.
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, "../..");
const dist = resolve(ext, "dist-screenshot");
const outDir = resolve(ext, "store-assets/screenshots");

const SCENES = ["01-direct-video", "02-stream-support", "03-refusal-safety"];

// Read the real shipped version so the popup footer in screenshots matches the
// package and never has to be hand-bumped here.
const manifestVersion = JSON.parse(await readFile(resolve(ext, "manifest.json"), "utf8")).version;

const build = spawnSync(
  "pnpm",
  ["exec", "vite", "build", "--config", resolve(here, "vite.config.ts")],
  { cwd: ext, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

await mkdir(outDir, { recursive: true });

// ES modules cannot load over file:// (browser CORS), so serve dist over HTTP.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".map": "application/json" };
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = resolve(dist, rel === "/" || rel === "." ? "index.html" : `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // Fall back to the real extension public/ dir (e.g. /icons/icon-48.png).
    try {
      const pub = await readFile(resolve(ext, "public", `.${rel.startsWith("/") ? rel : `/${rel}`}`));
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(pub);
    } catch {
      res.writeHead(404).end("not found");
    }
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
page.on("console", m => console.log(`  [page console] ${m.type()}: ${m.text()}`));
page.on("pageerror", e => console.log(`  [page error] ${e.message}`));

// Minimal chrome stub: the popup always runs inside an extension where `chrome`
// exists. The harness uses seeded data (skipFetch), so these are inert no-ops;
// getManifest returns the real version so the footer renders truthfully.
await page.addInitScript((version) => {
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version }),
      getURL: (p) => `/${p}`,
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: () => {},
      openOptionsPage: () => {},
    },
    tabs: { query: () => {} },
  };
}, manifestVersion);

for (const scene of SCENES) {
  await page.goto(`${origin}/index.html?scene=${scene}`);
  const frame = page.locator(`[data-scene="${scene}"]`);
  await frame.waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(150); // let fonts/layout settle
  const out = resolve(outDir, `${scene === "02-stream-support" ? "02-hls-vod" : scene}.png`);
  await frame.screenshot({ path: out });
  console.log(`✓ ${out}`);
}

// Promotional tile (optional store asset), written alongside the logo.
await page.goto(`${origin}/index.html?scene=promo-440x280`);
const promo = page.locator('[data-scene="promo-440x280"]');
await promo.waitFor({ state: "visible", timeout: 8000 });
await page.waitForTimeout(150);
const promoOut = resolve(ext, "store-assets/promo-440x280.png");
await promo.screenshot({ path: promoOut });
console.log(`✓ ${promoOut}`);

await browser.close();
server.close();
