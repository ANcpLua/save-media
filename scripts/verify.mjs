#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const steps = [
  ["bun", ["run", "typecheck"]],
  ["bun", ["run", "test"]],
  ["bun", ["run", "build:all"]],
  ["bunx", ["store-publish", "lint"]],
  ["bunx", ["store-publish", "readme", "--check"]],
  ["bunx", ["store-publish", "version"]],
  ["bun", ["run", "--filter", "@savemedia/extension", "screenshots"]],
  ["bun", ["run", "--filter", "@savemedia/extension", "test:e2e"]],
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
