/**
 * Unit tests for the pure resolveTheme helper.
 *
 * No React, no DOM — resolveTheme is a pure function that maps a user setting
 * + an OS preference boolean to the data-theme string written to <html>.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/unit/theme.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveTheme } from "../../src/renderer/lib/theme.ts";

describe("resolveTheme", () => {
  it('returns "dark" when setting is "dark", regardless of OS preference', () => {
    assert.equal(resolveTheme("dark", false), "dark");
    assert.equal(resolveTheme("dark", true), "dark");
  });

  it('returns "light" when setting is "light", regardless of OS preference', () => {
    assert.equal(resolveTheme("light", false), "light");
    assert.equal(resolveTheme("light", true), "light");
  });

  it('returns "system" when setting is "system"', () => {
    // "system" is returned as-is so the CSS @media queries can resolve it.
    assert.equal(resolveTheme("system", false), "system");
    assert.equal(resolveTheme("system", true), "system");
  });
});
