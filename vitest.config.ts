/**
 * Vitest config for component tests ONLY.
 *
 * The existing node:test suites (tests/integration/ and tests/unit/) are
 * NOT touched — they stay on `node --experimental-strip-types --test`.
 * This config is scoped exclusively to tests/component/**.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve("src/renderer"),
      "@shared": resolve("src/shared"),
    },
  },
  css: {
    // Treat CSS module imports as no-ops so tests aren't blocked on stylesheet
    // content — components' styling is irrelevant to behaviour assertions.
    modules: {
      // Return an object where every class name maps to itself (identity proxy),
      // so `styles.foo` evaluates to `"foo"` rather than undefined.
      generateScopedName: "[local]",
    },
  },
  test: {
    include: ["tests/component/**/*.test.tsx", "tests/component/**/*.test.ts"],
    environment: "jsdom",
    globals: false,
    setupFiles: ["tests/component/setup.ts"],
  },
});
