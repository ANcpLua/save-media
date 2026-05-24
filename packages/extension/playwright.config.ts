import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    command: "node tests/e2e/fixture-server.mjs",
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
            `--disable-extensions-except=${resolve(here, "dist-chrome")}`,
            `--load-extension=${resolve(here, "dist-chrome")}`,
          ],
          headless: false, // Chrome requires a headed window to load MV3 extensions
        },
      },
    },
    {
      name: "firefox-fixtures",
      testMatch: /fixtures\.spec\.ts/,
      use: {
        ...devices["Desktop Firefox"],
        // Firefox extension runtime coverage lives in scripts/smoke-firefox.mjs.
        // This Playwright project is fixture-server coverage only and must not
        // be counted as Firefox extension support evidence.
      },
    },
  ],
});
