#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(root, "dist-build");
const out = resolve(root, "dist-chrome");

const vite = spawnSync("bunx", ["vite", "build"], {
  cwd: root,
  env: { ...process.env, SAVEMEDIA_BROWSER: "chromium" },
  stdio: "inherit",
});
if (vite.status !== 0) process.exit(vite.status ?? 1);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
if (existsSync(buildDir)) await cp(buildDir, out, { recursive: true });

const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf-8"));
if (process.env.SAVEMEDIA_RELAY_URL) {
  manifest.version_name = manifest.version + " toolbar progress preview";
  manifest.content_security_policy = { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" };
  const vendor = resolve(out, "vendor/libcurl");
  await mkdir(vendor, { recursive: true });
  await cp(resolve(root, "licenses/GPL-3.0.txt"), resolve(vendor, "COPYING"));
  await cp(resolve(root, "../../NOTICE"), resolve(out, "NOTICE"));
  const library = dirname(fileURLToPath(import.meta.resolve("libcurl.js")));
  for (const file of ["libcurl.mjs", "libcurl.wasm", "LICENSE", "README.md"]) {
    await cp(resolve(library, file), resolve(vendor, file));
  }
}
await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("chrome build →", out);
