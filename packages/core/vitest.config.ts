import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bun runs Vitest. Bun's child processes have no channel.unref(), which Vitest's
    // default process pool calls, so the test files run in worker threads.
    pool: "threads",
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
