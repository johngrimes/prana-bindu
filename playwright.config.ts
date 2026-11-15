import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// One temp data dir per run, shared with workers through the environment.
process.env.PRANA_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), "prana-e2e-"));
const port = Number(process.env.PRANA_E2E_PORT ?? 3917);
const origin = `http://localhost:${port}`;
process.env.PRANA_E2E_ORIGIN = origin;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/e2e",
  // The undo journal and data set are global to the server, so specs run one at a time.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    timezoneId: "Australia/Brisbane",
    locale: "en-AU",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } }],
  webServer: {
    command: process.env.PRANA_E2E_SKIP_BUILD ? "node dist/server/cli/main.js serve" : "npm run build && node dist/server/cli/main.js serve",
    url: `${origin}/api/v1/openapi.json`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: "pipe",
    env: {
      PRANA_DATA_DIR: process.env.PRANA_E2E_DATA_DIR,
      PRANA_PORT: String(port),
      PRANA_ORIGIN: origin,
      PRANA_BLOB_DRIVER: "fs",
    },
  },
});
