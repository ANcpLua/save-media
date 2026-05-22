#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const nativeHostVenv = resolve(repoRoot, "native-host/.venv/bin/pytest");

const steps = [
  ["pnpm", ["-r", "typecheck"]],
  ["pnpm", ["-r", "test"]],
  ["pnpm", ["-r", "build"]],
  ["pnpm", ["--filter", "@savemedia/extension", "build:firefox"]],
];

if (existsSync(nativeHostVenv)) {
  steps.push([nativeHostVenv, ["-q"]]);
} else {
  console.warn(
    "warn: native-host/.venv not initialized; skipping pytest. " +
    "Run `cd native-host && python3 -m venv .venv && .venv/bin/pip install -e .[dev]` to enable.",
  );
}

for (const [cmd, args] of steps) {
  const cwd = cmd.includes("/pytest") ? resolve(repoRoot, "native-host") : repoRoot;
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.status !== 0) {
    console.error(`✘ failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

console.log("\n✓ verify complete");
