#!/usr/bin/env node
/**
 * Derive the manifest icons from the designed logo master
 * (store-assets/logo/logo-1024-transparent.png), composited on the brand
 * navy so the toolbar tile matches the store assets.
 *
 * Outputs (public/icons/): icon-16.png, icon-32.png, icon-48.png, icon-128.png
 * Also refreshes store-assets/logo/logo-{256,300,512,1024}.png from the same master.
 *
 * Requires ImageMagick (`magick`). Run: pnpm --filter @savemedia/extension icons
 * Then run `pnpm --filter @savemedia/extension store:assets` for the store files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = resolve(root, "store-assets/logo/logo-1024-transparent.png");
const ICONS = resolve(root, "public/icons");
const LOGOS = resolve(root, "store-assets/logo");
const NAVY = "#202a35";

const magick = ["magick", "convert"].find(bin => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
if (!magick) {
  console.error("✘ ImageMagick not found (need `magick` or `convert` on PATH)");
  process.exit(1);
}
if (!existsSync(MASTER)) {
  console.error(`✘ logo master missing: ${MASTER}`);
  process.exit(1);
}

mkdirSync(ICONS, { recursive: true });
const targets = [
  ...[16, 32, 48, 128].map(size => ({ out: resolve(ICONS, `icon-${size}.png`), size })),
  ...[256, 300, 512, 1024].map(size => ({ out: resolve(LOGOS, `logo-${size}.png`), size })),
];

for (const t of targets) {
  const r = spawnSync(magick, [
    "-size", `${t.size}x${t.size}`, `xc:${NAVY}`,
    MASTER, "-filter", "Lanczos", "-resize", `${t.size}x${t.size}`, "-gravity", "center", "-composite",
    `PNG32:${t.out}`,
  ], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✘ failed to build ${t.out}`);
    process.exit(r.status ?? 1);
  }
  console.log(`✓ ${t.out} (${t.size}x${t.size})`);
}
