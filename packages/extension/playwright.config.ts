import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionBrowser, extensionDist } from "./tests/e2e/extension-browser";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // extension under test is global; avoid races
  workers: 1,
  forbidOnly: !!process.env.CI,
  outputDir: "test-results/e2e-artifacts",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/e2e-results.json" }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  webServer: {
    command: "bun tests/e2e/fixture-server.mjs",
    port: Number(process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174),
    reuseExistingServer: !process.env.CI,
    cwd: here,
    env: { SAVEMEDIA_FIXTURE_PORT: String(process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174) },
  },
  use: {
    baseURL: `http://127.0.0.1:${process.env.SAVEMEDIA_FIXTURE_PORT ?? 5174}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            `--disable-extensions-except=${extensionDist}`,
            `--load-extension=${extensionDist}`,
          ],
          ...extensionBrowser,
        },
      },
    },
    {
      name: "firefox-fixtures",
      testMatch: /fixtures\.spec\.ts/,
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          env: {
            ...process.env,
            MOZ_APP_DATA: resolve(here, "test-results/e2e-artifacts/firefox-app-data"),
            MOZ_LOCAL_APP_DATA: resolve(here, "test-results/e2e-artifacts/firefox-app-cache"),
          },
        },
        // Firefox extension runtime coverage lives in scripts/smoke-firefox.mjs.
        // This Playwright project is fixture-server coverage only and must not
        // be counted as Firefox extension support evidence.
      },
    },
  ],
});
