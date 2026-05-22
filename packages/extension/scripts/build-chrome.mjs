#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(root, "dist-build");
const out = resolve(root, "dist-chrome");

const vite = spawnSync("pnpm", ["exec", "vite", "build"], {
  cwd: root,
  env: { ...process.env, SAVEMEDIA_BROWSER: "chromium" },
  stdio: "inherit",
});
if (vite.status !== 0) process.exit(vite.status ?? 1);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
if (existsSync(buildDir)) await cp(buildDir, out, { recursive: true });

const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf-8"));
await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("chrome build →", out);
