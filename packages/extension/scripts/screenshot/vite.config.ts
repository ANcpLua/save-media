import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Standalone build of the store-screenshot harness. base:'./' keeps asset URLs
// relative so the output loads over file:// in the Playwright capture step.
export default defineConfig({
  root: here,
  base: "./",
  plugins: [react()],
  define: { __BROWSER__: JSON.stringify("chromium") },
  build: {
    outDir: resolve(here, "../../dist-screenshot"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(here, "index.html") },
  },
});
