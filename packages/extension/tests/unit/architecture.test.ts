import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

interface Import { readonly from: string; readonly to: string; readonly typeOnly: boolean }

/** Every relative import in src, with the area (first folder under src) of both ends. */
function imports(): Import[] {
  const found: Import[] = [];
  for (const file of files(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm)) {
      found.push({ from: relative(SRC, file), to: relative(SRC, resolve(dirname(file), match[3]!)), typeOnly: !!match[2] });
    }
    for (const match of text.matchAll(/^\s*import\s+"(\.{1,2}\/[^"]+)"/gm)) {
      found.push({ from: relative(SRC, file), to: relative(SRC, resolve(dirname(file), match[1]!)), typeOnly: false });
    }
  }
  return found;
}

const area = (path: string): string => path.split("/")[0]!;

/** area -> the areas it must not import from. */
const FORBIDDEN: Readonly<Record<string, readonly string[]>> = {
  util: ["engine", "background", "popup", "content", "native", "platform"],
  types: ["engine", "background", "popup", "content", "platform"],
  engine: ["background", "popup", "content"],
  popup: ["background", "engine", "content"],
  content: ["background", "engine", "popup", "native"],
  selection: ["background", "engine", "popup", "content", "native", "platform"],
  ui: ["background", "engine", "popup", "content", "native", "platform", "selection"],
};

describe("which part of the extension may import which", () => {
  const all = imports();

  it("finds the imports it is meant to judge", () => {
    expect(all.length).toBeGreaterThan(200);
    expect(all.some(item => item.from === "background/index.ts" && item.to === "background/router")).toBe(true);
  });

  it.each(Object.entries(FORBIDDEN))("%s imports nothing from %j", (from, forbidden) => {
    const broken = all.filter(item => area(item.from) === from && forbidden.includes(area(item.to)) && !item.typeOnly)
      .map(item => `${item.from} -> ${item.to}`);
    expect(broken).toEqual([]);
  });

  it("the page scripts take only types from the message catalogue, so no schema library reaches a page", () => {
    const broken = all.filter(item => area(item.from) === "content" && item.to === "types/messages" && !item.typeOnly)
      .map(item => item.from);
    expect(broken).toEqual([]);
    for (const file of files(join(SRC, "content"))) expect(readFileSync(file, "utf8")).not.toMatch(/from\s+"zod"/);
  });

  it("the page bridge takes its toast words from a catalogue that imports nothing, so no library rides along into a page", () => {
    expect(all.filter(item => item.from === "ui/toast-text.ts")).toEqual([]);
    expect(readFileSync(join(SRC, "ui/toast-text.ts"), "utf8")).not.toMatch(/^\s*import\s/m);
    // The larger catalogue needs core for its failure texts: the page scripts never import it.
    expect(all.filter(item => area(item.from) === "content" && item.to === "ui/text").map(item => item.from)).toEqual([]);
    expect(all.some(item => item.from === "content/bridge.ts" && item.to === "ui/toast-text")).toBe(true);
  });

  it("the service worker reaches the engine's muxer through no import: it loads the engine only as the build's local-engine module", () => {
    const direct = all.filter(item => area(item.from) === "background" && /^engine\/(in-process-host|download|runner|jobs|remux)/.test(item.to) && !item.typeOnly)
      .map(item => `${item.from} -> ${item.to}`);
    expect(direct).toEqual([]);
  });
});
