/**
 * pickPreviewTarget — pure router that decides whether a `tool_end` event
 * should auto-open the PreviewPanel, and with which target.
 *
 * Kept as a standalone pure function so it can be unit-tested without React.
 *
 * Whitelist (D8): only deliverable-producing tools auto-open. Read-only tools
 * (file_read, glob_match, etc.) intentionally never trigger a preview panel —
 * the user did not ask the agent to *produce* anything.
 *
 * Browser preview (BP-A): browser_* tool_start opens a live browser preview;
 * see shouldOpenBrowserPreview() below.
 */

import type { PreviewTarget } from "../components/PreviewPanel.tsx";
import type { ToolResult } from "@shared/types.ts";

export const AUTO_PREVIEW_TOOLS = new Set<string>([
  "file_write",
  "file_edit",
  "file_edit_enhanced",
  "file_move",
  "file_copy",
  "screenshot",
  "browser_screenshot",
  "computer_screenshot",
]);

export function shouldAutoOpen(toolName: string): boolean {
  return AUTO_PREVIEW_TOOLS.has(toolName);
}

/**
 * Browser tool-start preview set. Opening on tool_start (rather than tool_end)
 * lets the user watch the page load live as the agent drives it. We include
 * all browser_* tools so clicks/types are also visible — the live view is
 * read-only observation by default (OQ-1).
 */
export const BROWSER_PREVIEW_TOOLS = new Set<string>([
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_wait",
  "browser_screenshot",
  "browser_extract",
  "browser_back",
  "browser_forward",
  "browser_get_content",
  "browser_close",
]);

export function shouldOpenBrowserPreview(toolName: string): boolean {
  return BROWSER_PREVIEW_TOOLS.has(toolName);
}

/**
 * Resolve a PreviewTarget for a successful tool_end, or null if nothing should
 * auto-open for this tool/output.
 */
export function pickPreviewTarget(
  toolName: string,
  result: ToolResult,
): PreviewTarget | null {
  if (!result.ok) return null;

  // File-producing tools → open the first file in display.files.
  if (AUTO_PREVIEW_TOOLS.has(toolName)) {
    const files = result.display?.files;
    if (files && files.length > 0) {
      const path = files[0];
      // HTML file targets are served through the hardened loopback/live
      // Chromium preview; explicit artifact targets remain static and sanitized.
      return { kind: "file", path };
    }

    // Screenshot-family tools ship already-encoded base64 tiles in result.images.
    if (
      (toolName === "screenshot" ||
        toolName === "browser_screenshot" ||
        toolName === "computer_screenshot") &&
      result.images &&
      result.images.length > 0
    ) {
      const im = result.images[0];
      return { kind: "computer", imageData: `data:${im.mimeType};base64,${im.data}` };
    }
  }

  return null;
}
