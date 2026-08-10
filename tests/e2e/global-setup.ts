/**
 * Playwright global setup — runs before any test file.
 *
 * Checks that out/main/index.js exists. If it doesn't, fails immediately with
 * a clear developer message instead of a cryptic Electron launch error.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const MAIN_BUNDLE = join(ROOT, "out", "main", "index.js");

export default async function globalSetup() {
  if (!existsSync(MAIN_BUNDLE)) {
    throw new Error(
      `\n` +
      `E2E pre-flight check failed:\n` +
      `  ${MAIN_BUNDLE} does not exist.\n` +
      `\n` +
      `Run the build before running E2E tests:\n` +
      `  npm run build\n` +
      `  npm run test:e2e\n` +
      `\n` +
      `On Linux CI, ensure a virtual display is available:\n` +
      `  xvfb-run -a npm run test:e2e\n`,
    );
  }
}
