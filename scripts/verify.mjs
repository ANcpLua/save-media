#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  ["pnpm", ["--filter", "@savemedia/core", "build"]],
  ["pnpm", ["-r", "typecheck"]],
  ["pnpm", ["-r", "test"]],
  ["pnpm", ["-r", "build"]],
  ["pnpm", ["--filter", "@savemedia/extension", "build:firefox"]],
  ["pnpm", ["--filter", "@savemedia/extension", "test:e2e"]],
];

for (const [cmd, args] of steps) {
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✘ failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

console.log("\n✓ verify complete");
