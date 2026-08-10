/**
 * Unit tests for pickPreviewTarget — the pure router that decides whether a
 * successful tool_end should auto-open the PreviewPanel and with which target.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  shouldAutoOpen,
  pickPreviewTarget,
  AUTO_PREVIEW_TOOLS,
} from "../../src/renderer/lib/pickPreviewTarget.ts";
import type { ToolResult } from "../../src/shared/types.ts";

const OK: ToolResult = { ok: true, content: "wrote 4 chars" };

describe("shouldAutoOpen", () => {
  it("includes the eight deliverable tools (D8)", () => {
    assert.ok(AUTO_PREVIEW_TOOLS.has("file_write"));
    assert.ok(AUTO_PREVIEW_TOOLS.has("file_edit"));
    assert.ok(AUTO_PREVIEW_TOOLS.has("file_edit_enhanced"));
    assert.ok(AUTO_PREVIEW_TOOLS.has("file_move"));
    assert.ok(AUTO_PREVIEW_TOOLS.has("file_copy"));
    assert.ok(AUTO_PREVIEW_TOOLS.has("screenshot"));
    assert.ok(AUTO_PREVIEW_TOOLS.has("browser_screenshot"));
    assert.ok(AUTO_PREVIEW_TOOLS.has("computer_screenshot"));
  });

  it("returns true only for whitelisted tools", () => {
    assert.equal(shouldAutoOpen("file_write"), true);
    assert.equal(shouldAutoOpen("file_read"), false);
    assert.equal(shouldAutoOpen("shell_exec"), false);
    assert.equal(shouldAutoOpen("mcp_call"), false);
  });
});

describe("pickPreviewTarget", () => {
  it("returns a file target when file_write returns display.files[0]", () => {
    const target = pickPreviewTarget("file_write", {
      ...OK,
      display: { summary: "wrote", files: ["/tmp/hi.txt"] },
    });
    assert.deepEqual(target, { kind: "file", path: "/tmp/hi.txt" });
  });

  it("returns a computer target for screenshot tools with images", () => {
    const target = pickPreviewTarget("computer_screenshot", {
      ...OK,
      images: [{ mimeType: "image/png", data: "BASE64" }],
    });
    assert.deepEqual(target, {
      kind: "computer",
      imageData: "data:image/png;base64,BASE64",
    });
  });

  it("returns null for non-deliverable tools", () => {
    const target = pickPreviewTarget("file_read", {
      ...OK,
      display: { summary: "read", files: ["/tmp/hi.txt"] },
    });
    assert.equal(target, null);
  });

  it("returns null when the result is an error", () => {
    const target = pickPreviewTarget("file_write", {
      ok: false,
      content: "",
      error: "permission denied",
      display: { summary: "denied", files: ["/tmp/hi.txt"] },
    });
    assert.equal(target, null);
  });

  it("returns null when a deliverable tool produces no previewable artefact", () => {
    const target = pickPreviewTarget("file_write", {
      ...OK,
      display: { summary: "ok" },
    });
    assert.equal(target, null);
  });
});
