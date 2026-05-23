#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/icons");

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(resolve(outDir, `icon-${size}.png`), makeIcon(size));
}
console.log(`icons -> ${outDir}`);

function makeIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const scale = size / 128;
  const set = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = rgba[0];
    pixels[i + 1] = rgba[1];
    pixels[i + 2] = rgba[2];
    pixels[i + 3] = rgba[3];
  };
  const rect = (x, y, w, h, rgba) => {
    for (let yy = Math.round(y * scale); yy < Math.round((y + h) * scale); yy++) {
      for (let xx = Math.round(x * scale); xx < Math.round((x + w) * scale); xx++) set(xx, yy, rgba);
    }
  };
  const poly = (points, rgba) => {
    const scaled = points.map(([x, y]) => [x * scale, y * scale]);
    const minY = Math.floor(Math.min(...scaled.map(p => p[1])));
    const maxY = Math.ceil(Math.max(...scaled.map(p => p[1])));
    for (let y = minY; y <= maxY; y++) {
      const hits = [];
      for (let i = 0, j = scaled.length - 1; i < scaled.length; j = i++) {
        const [xi, yi] = scaled[i];
        const [xj, yj] = scaled[j];
        if ((yi > y) !== (yj > y)) hits.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
      hits.sort((a, b) => a - b);
      for (let h = 0; h < hits.length; h += 2) {
        for (let x = Math.ceil(hits[h]); x <= Math.floor(hits[h + 1]); x++) set(x, y, rgba);
      }
    }
  };

  const bg = [17, 44, 62, 255];
  const panel = [34, 111, 118, 255];
  const play = [255, 205, 86, 255];
  const white = [245, 248, 250, 255];

  rect(0, 0, 128, 128, bg);
  rect(18, 24, 92, 58, panel);
  rect(18, 80, 92, 8, [12, 26, 38, 255]);
  poly([[52, 38], [52, 68], [78, 53]], play);
  rect(59, 80, 10, 26, white);
  poly([[47, 99], [81, 99], [64, 116]], white);

  const scanlines = [0, 0, 0, 30];
  for (let y = 8; y < 128; y += 12) rect(0, y, 128, 2, scanlines);

  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]));
    rows.push(Buffer.from(pixels.subarray(y * size * 4, (y + 1) * size * 4)));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.concat([
      u32(size),
      u32(size),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    u32(data.length),
    typeBuffer,
    data,
    u32(crc32(Buffer.concat([typeBuffer, data]))),
  ]);
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0);
  return b;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
