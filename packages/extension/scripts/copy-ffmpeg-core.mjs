#!/usr/bin/env node
import { mkdir, cp, access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = resolve(root, "public/vendor/ffmpeg");

const candidates = [
  resolve(root, "node_modules/@ffmpeg/core/dist/umd"),
  resolve(root, "../../node_modules/@ffmpeg/core/dist/umd"),
];

async function findCore() {
  for (const dir of candidates) {
    try {
      await access(`${dir}/ffmpeg-core.js`, constants.R_OK);
      return dir;
    } catch {}
  }
  return null;
}

const src = await findCore();
if (!src) {
  console.warn(
    "warn: @ffmpeg/core not found in node_modules — vendor/ffmpeg/ will be empty. " +
    "Install @ffmpeg/core as a devDependency to bundle the WebAssembly engine.",
  );
  process.exit(0);
}

await mkdir(dest, { recursive: true });
for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  await cp(`${src}/${name}`, `${dest}/${name}`);
}
console.log(`ffmpeg core → ${dest}`);
