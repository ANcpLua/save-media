#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(root, "dist-build");
// Unpacked previews carry a stable, public extension identity so moving the
// folder keeps the local downloader helper's user-scoped Chrome registration.
const preview = process.argv.includes("--preview");
const out = resolve(root, preview ? "dist-preview" : "dist-chrome");

const vite = spawnSync("bunx", ["--bun", "vite", "build"], {
  cwd: root,
  env: { ...process.env, SAVEMEDIA_BROWSER: "chromium" },
  stdio: "inherit",
});
if (vite.status !== 0) process.exit(vite.status ?? 1);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
if (existsSync(buildDir)) await cp(buildDir, out, { recursive: true });

const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf-8"));
if (preview) {
  const { key, description } = JSON.parse(await readFile(resolve(root, "manifest.preview.json"), "utf-8"));
  manifest.key = key;
  manifest.description = description;
  manifest.permissions.push("nativeMessaging");
  manifest.optional_permissions = manifest.optional_permissions.filter(permission => permission !== "nativeMessaging");
  if (!manifest.optional_permissions.length) delete manifest.optional_permissions;
}
await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("chrome build →", out);
