/**
 * Playwright config for Electron end-to-end tests.
 *
 * Prerequisites:
 *   1. Run `npm run build` first — tests launch out/main/index.js.
 *   2. On Linux CI: wrap the command with xvfb-run -a (see CI workflow).
 *
 * If out/main/index.js is absent the tests will fail with a clear diagnostic
 * message rather than a cryptic Playwright error (see globalSetup).
 */

import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

export default defineConfig({
  testDir: join(ROOT, "tests", "e2e"),
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1, // Electron tests must be serialised (one window at a time).
  reporter: [
    ["list"],
    ["html", { outputFolder: join(ROOT, "playwright-report"), open: "never" }],
  ],
  use: {
    // Playwright does not have a built-in Electron "device" — each test
    // launches via _electron.launch() instead. These settings are for
    // the page object that Playwright attaches to the Electron window.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  globalSetup: join(ROOT, "tests", "e2e", "global-setup.ts"),
});
