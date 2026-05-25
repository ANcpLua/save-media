#!/usr/bin/env node
/**
 * Pack chrome + firefox + edge release zips from the already-built dist
 * directories. Run `pnpm build:all` first so dist-chrome and dist-firefox
 * exist; this script does not invoke vite itself so CI can decouple the
 * pack step from the build step and parallelise.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
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

  // AMO's source-archive upload runs the same extension validator as the XPI
  // upload — it expects a valid Firefox extension at the zip root. We satisfy
  // that by staging the built dist-firefox tree at root AND placing the full
  // git-tracked source tree under /source/ for reviewers to build from.
  const stage = mkdtempSync(join(tmpdir(), "savemedia-source-"));
  try {
    cpSync(resolve(root, "dist-firefox"), stage, { recursive: true });

    const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot });
    if (tracked.status !== 0) {
      console.error("✘ could not list tracked source files");
      process.exit(tracked.status ?? 1);
    }
    const files = tracked.stdout.toString()
      .split("\0")
      .filter(Boolean)
      .filter(file => !file.endsWith(".crx") && !file.endsWith(".pem") && !file.endsWith(".zip"));

    const sourceDir = resolve(stage, "source");
    for (const f of files) {
      const dest = resolve(sourceDir, f);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(resolve(repoRoot, f), dest);
    }

    const r = spawnSync("zip", ["-rq", out, "."], { cwd: stage, stdio: "inherit" });
    if (r.status !== 0) {
      console.error("✘ source zip failed");
      process.exit(r.status ?? 1);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  console.log(`✓ ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
}
