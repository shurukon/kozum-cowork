/**
 * preview_open — agent-controlled preview (W4).
 *
 * Gives the agent first-class control over the user-facing preview panel:
 * any file path (session-relative or absolute, by explicit product decision —
 * the user asked for 100% unrestricted control) or URL opens instantly.
 * Rendering stays read-only and reuses the existing preview:readFile sandbox
 * on the IPC side; this tool only decides WHAT the panel shows.
 */

import { join, isAbsolute } from "node:path";
import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";
import { previewKindForPath } from "../../renderer/lib/previewKind.ts";

export function makePreviewTool(): Tool {
  return {
    definition: {
      name: "preview_open",
      title: "Open Preview",
      description:
        "Open a file or URL in the user's preview panel immediately. Use it whenever " +
        "the user asks to see something (\"open the image\", \"show me the report\") " +
        "or right after you produce a deliverable worth looking at. Images, HTML, " +
        "Markdown, PDFs, text/code and videos all render inline. Accepts a session-" +
        "relative or absolute file path, or an http(s) URL.",
      icon: "monitor",
      group: "filesystem",
      dangerous: false,
      modes: ["cowork", "code"],
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to preview. Session-relative or absolute.",
          },
          url: {
            type: "string",
            description: "http(s) URL to preview instead of a file.",
          },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, ctx) => {
      const rawPath = typeof input["path"] === "string" ? (input["path"] as string).trim() : "";
      const rawUrl = typeof input["url"] === "string" ? (input["url"] as string).trim() : "";

      if (!rawPath && !rawUrl) {
        return fail("Invalid input: provide exactly one of `path` or `url`.");
      }
      if (rawPath && rawUrl) {
        return fail("Invalid input: pass either `path` or `url`, not both.");
      }

      if (rawUrl) {
        if (!/^https?:\/\//i.test(rawUrl)) {
          return fail("Invalid url: only http(s) URLs can be previewed.");
        }
        if (!ctx.onPreviewOpen) {
          // Headless/test context: resolution succeeded, there is just no
          // renderer surface attached to this executor.
          return ok(`Preview target resolved: ${rawUrl} (no preview panel is attached in this context).`, {
            summary: "Preview resolved",
          });
        }
        ctx.onPreviewOpen({ kind: "url", url: rawUrl });
        return ok(`Opened ${rawUrl} in the preview panel.`, { summary: "Preview opened" });
      }

      const base = ctx.workingFolder ?? ctx.outputsDir ?? process.cwd();
      const resolved = isAbsolute(rawPath) ? rawPath : join(base, rawPath);
      const kind = previewKindForPath(resolved);
      const outside =
        ctx.workingFolder !== null &&
        !resolved.toLowerCase().startsWith(ctx.workingFolder.toLowerCase());

      if (!ctx.onPreviewOpen) {
        return ok(
          `Preview target resolved: ${resolved} (${kind}) — no preview panel is attached in this context.`,
          { summary: `Preview resolved: ${rawPath}` },
        );
      }
      ctx.onPreviewOpen({ kind: "file", path: resolved });
      return ok(
        `Opened ${resolved} in the preview panel (${kind}${outside ? ", outside the session workspace" : ""}).`,
        { summary: `Preview: ${rawPath}` },
      );
    },
  };
}
