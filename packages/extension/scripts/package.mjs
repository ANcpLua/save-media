#!/usr/bin/env node
/**
 * Pack chrome + firefox + edge release zips from the already-built dist
 * directories. Run `pnpm build:all` first so dist-chrome and dist-firefox
 * exist; this script does not invoke vite itself so CI can decouple the
 * pack step from the build step and parallelise.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "../..");
const version = readVersion();

// Edge ships the chromium build verbatim; just rename the zip so release
// pipelines can publish to the Edge add-ons catalog with the right name.
const targets = [
  { name: "chrome",  dir: "dist-chrome" },
  { name: "edge",    dir: "dist-chrome" },
  { name: "firefox", dir: "dist-firefox" },
];

for (const t of targets) {
  const src = resolve(root, t.dir);
  if (!existsSync(src)) {
    console.error(`✘ ${t.dir} missing — run pnpm build:all first`);
    process.exit(1);
  }
  const out = resolve(root, `savemedia-${t.name}-${version}.zip`);
  rmSync(out, { force: true });
  const r = spawnSync("zip", ["-r", "-q", out, "."], { cwd: src, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✘ zip failed for ${t.name}`);
    process.exit(r.status ?? 1);
  }
  addLicenseFiles(out);
  console.log(`✓ ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
}

createSourceArchive(version);

function readVersion() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return pkg.version ?? "0.0.0";
}

function addLicenseFiles(zipPath) {
  const r = spawnSync("zip", ["-q", "-j", zipPath, "LICENSE", "NOTICE"], { cwd: repoRoot, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✘ license packaging failed for ${zipPath}`);
    process.exit(r.status ?? 1);
  }
}

function createSourceArchive(packageVersion) {
  const out = resolve(root, `savemedia-source-${packageVersion}.zip`);
  rmSync(out, { force: true });

  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot });
  if (tracked.status !== 0) {
    console.error("✘ could not list tracked source files");
    process.exit(tracked.status ?? 1);
  }

  const files = tracked.stdout.toString()
    .split("\0")
    .filter(Boolean)
    .filter(file => !file.endsWith(".crx") && !file.endsWith(".pem") && !file.endsWith(".zip"));

  const r = spawnSync("zip", ["-q", out, ...files], { cwd: repoRoot, stdio: "inherit" });
  if (r.status !== 0) {
    console.error("✘ source zip failed");
    process.exit(r.status ?? 1);
  }

  // AMO's source-archive validator runs extension-package checks and fails if
  // manifest.json is not at the zip root. Junk-add the extension's manifest at
  // root so the validator accepts the archive; the full repo tree (including
  // the real packages/extension/manifest.json) is still inside for reviewers.
  const addRootManifest = spawnSync(
    "zip", ["-q", "-j", out, "packages/extension/manifest.json"],
    { cwd: repoRoot, stdio: "inherit" }
  );
  if (addRootManifest.status !== 0) {
    console.error("✘ failed to add root manifest.json to source zip");
    process.exit(addRootManifest.status ?? 1);
  }

  console.log(`✓ ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
}
