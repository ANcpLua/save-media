#!/usr/bin/env node
/**
 * Derive store-listing image assets from the REAL designed logo
 * (public/icons/icon-128.png), not from generate-icons.mjs — that script draws
 * a procedural placeholder, which is a different image. Store uploaders also
 * reject PNGs with an alpha channel, so every output is flattened onto the
 * brand navy and exported as 24-bit RGB (no alpha).
 *
 * Outputs (store-assets/):
 *   store-logo-300.png        Edge logo (300x300, RGB)
 *   store-icon-128-chrome.png Chrome Web Store icon (128x128, RGB)
 *
 * Requires ImageMagick (`magick`). Run: pnpm --filter @savemedia/extension store:assets
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(root, "public/icons/icon-128.png"); // real designed logo
const OUT = resolve(root, "store-assets");
const NAVY = "#0e1b26";

const magick = ["magick", "convert"].find(bin => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
if (!magick) {
  console.error("✘ ImageMagick not found (need `magick` or `convert` on PATH)");
  process.exit(1);
}
if (!existsSync(SRC)) {
  console.error(`✘ source logo missing: ${SRC} (run \`pnpm icons\` first?)`);
  process.exit(1);
}

const targets = [
  { name: "store-logo-300.png", size: 300 },
  { name: "store-icon-128-chrome.png", size: 128 },
];

for (const t of targets) {
  const out = resolve(OUT, t.name);
  // Composite the (possibly transparent) logo centered over a solid navy
  // canvas of the target size, then drop the alpha channel → 24-bit RGB.
  const r = spawnSync(magick, [
    "-size", `${t.size}x${t.size}`, `xc:${NAVY}`,
    SRC, "-resize", `${t.size}x${t.size}`, "-gravity", "center", "-composite",
    "-alpha", "off", `PNG24:${out}`,
  ], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✘ failed to build ${t.name}`);
    process.exit(r.status ?? 1);
  }
  console.log(`✓ ${out} (${t.size}x${t.size}, RGB)`);
}
