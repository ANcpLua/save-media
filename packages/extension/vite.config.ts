import { defineConfig } from "vite";
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

export default defineConfig(() => {
  const target = browserTarget();
  return {
    plugins: [react()],
    define: {
      __BROWSER__: JSON.stringify(target),
    },
    build: {
      target: "es2022",
      outDir: target === "firefox" ? "dist-firefox-build" : "dist-build",
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          background: resolve(here, "src/background/index.ts"),
          "content-main": resolve(here, "src/content/main.ts"),
          "content-bridge": resolve(here, "src/content/bridge.ts"),
          popup: resolve(here, "src/popup/index.html"),
          ...(target === "chromium"
            ? { offscreen: resolve(here, "src/engine/offscreen.html") }
            : {}),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          // Content scripts in MV3 are injected as classic scripts; ES
          // module `import` statements would be a syntax error. Keep
          // content-main and content-bridge self-contained by inlining
          // their dynamic imports and never sharing chunks with them.
          manualChunks(id) {
            // Force the SW window-shim into its own chunk. Otherwise
            // rollup inlines it into background.js and the side effect
            // ends up AFTER the hoisted `import` statements that pull
            // in m3u8-parser / mpd-parser — by then it's too late.
            // As a dedicated chunk it's a top-of-file `import` and
            // ESM evaluation order guarantees it runs first.
            if (id.endsWith("/src/sw-globals-polyfill.ts")) return "sw-globals-polyfill";
            if (id.includes("/src/content/")) return undefined;
            return undefined;
          },
        },
      },
    },
  };
});
