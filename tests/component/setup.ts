/**
 * Vitest component test setup.
 *
 * - Provides @testing-library/jest-dom matchers.
 * - Stubs out window.matchMedia (jsdom doesn't implement it).
 * - Resets all spies / mocks between tests.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom does not implement matchMedia. Provide a minimal stub so hooks that
// read prefers-color-scheme / prefers-reduced-motion don't throw.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Clean up rendered trees after each test to avoid cross-test contamination.
afterEach(() => {
  cleanup();
});
