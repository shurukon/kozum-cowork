/**
 * Unit tests for pickPreviewTarget browser-preview routing.
 *
 * Covers T2.2: shouldOpenBrowserPreview whitelist, and the browser preview
 * target kind that App.tsx opens on tool_start.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  shouldOpenBrowserPreview,
  BROWSER_PREVIEW_TOOLS,
} from "../../src/renderer/lib/pickPreviewTarget.ts";

describe("shouldOpenBrowserPreview", () => {
  it("returns true for all browser_* tools in the whitelist", () => {
    for (const name of BROWSER_PREVIEW_TOOLS) {
      assert.equal(shouldOpenBrowserPreview(name), true, `Expected ${name} to open browser preview`);
    }
  });

  it("returns false for non-browser tools", () => {
    assert.equal(shouldOpenBrowserPreview("file_write"), false);
    assert.equal(shouldOpenBrowserPreview("screenshot"), false);
    assert.equal(shouldOpenBrowserPreview("shell_exec"), false);
    assert.equal(shouldOpenBrowserPreview(""), false);
  });

  it("does not match partial prefixes (e.g. browser_foo is not whitelisted)", () => {
    assert.equal(shouldOpenBrowserPreview("browser_foo"), false);
    assert.equal(shouldOpenBrowserPreview("browser"), false);
  });
});
