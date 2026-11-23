import { build, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function browserTarget(): "chromium" | "firefox" {
  const env = process.env["SAVEMEDIA_BROWSER"]?.toLowerCase();
  if (env === "firefox") return "firefox";
  if (env === "chromium" || env === "chrome" || env === "edge" || !env) return "chromium";
  throw new Error(`Unknown SAVEMEDIA_BROWSER value: ${env}`);
}

const CONTENT_ENTRIES = { "content-main": "src/content/main.ts", "content-bridge": "src/content/bridge.ts" } as const;

/**
 * Store packages (`bun run zip`) are built with SAVEMEDIA_STORE_BUILD=1. They
 * leave out the one site reader whose site the Chrome Web Store does not let
 * extensions save from (src/content/sites/registry.ts); scripts/package.mjs
 * refuses to pack a build that still carries it.
 */
const STORE_BUILD = process.env["SAVEMEDIA_STORE_BUILD"] === "1";
const buildFlags = (target: "chromium" | "firefox") => ({
  __BROWSER__: JSON.stringify(target),
  __STORE_BUILD__: JSON.stringify(STORE_BUILD),
});

/**
 * MV3 content scripts are classic scripts: a top-level `import` is a syntax
 * error. Each one is its own IIFE build, so modules it shares with the
 * background or with the other content script are inlined, never chunked.
 * The guard fails the build if an entry would not load as a classic script.
 */
function classicContentScripts(target: "chromium" | "firefox", outDir: string): Plugin {
  return {
    name: "savemedia-classic-content-scripts",
    apply: "build",
    async closeBundle() {
      for (const [name, entry] of Object.entries(CONTENT_ENTRIES)) {
        const result = await build({
          configFile: false,
          publicDir: false,
          logLevel: "warn",
          define: buildFlags(target),
          build: {
            target: "es2022",
            outDir,
            emptyOutDir: false,
            sourcemap: true,
            modulePreload: false,
            rollupOptions: {
              input: { [name]: resolve(here, entry) },
              output: { format: "iife", entryFileNames: "[name].js" },
            },
          },
        });
        const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : []);
        const chunks = outputs.filter(item => item.type === "chunk");
        if (chunks.length !== 1) throw new Error(`${name} was split into ${chunks.length} files; a content script must be one classic script`);
        if (/^\s*(import|export)\b/m.test(chunks[0]!.code)) throw new Error(`${name} is not a classic script: it contains a module statement`);
      }
    },
  };
}

export default defineConfig(() => {
  const target = browserTarget();
  const outDir = target === "firefox" ? "dist-firefox-build" : "dist-build";
  return {
    plugins: [react(), classicContentScripts(target, resolve(here, outDir))],
    define: buildFlags(target),
    resolve: {
      // Chromium runs the engine in the offscreen document. Its service worker
      // must not load the engine and its muxer, and a static import would pull
      // them into the worker's chunk even when the code that uses them is dead.
      alias: target === "chromium"
        ? [{ find: /^.*\/platform\/local-engine$/, replacement: resolve(here, "src/platform/local-engine.none.ts") }]
        : [],
    },
    build: {
      target: "es2022",
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          background: resolve(here, "src/background/index.ts"),
          popup: resolve(here, "src/popup/index.html"),
          ...(target === "chromium"
            ? { offscreen: resolve(here, "src/engine/offscreen.html") }
            : {}),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          manualChunks(id) {
            // Force the SW window-shim into its own chunk. Otherwise
            // rollup inlines it into background.js and the side effect
            // ends up AFTER the hoisted `import` statements that pull
            // in m3u8-parser / mpd-parser — by then it's too late.
            // As a dedicated chunk it's a top-of-file `import` and
            // ESM evaluation order guarantees it runs first.
            if (id.endsWith("/src/sw-globals-polyfill.ts")) return "sw-globals-polyfill";
            return undefined;
          },
        },
      },
    },
  };
});
