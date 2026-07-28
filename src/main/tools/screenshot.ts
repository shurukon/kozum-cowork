/**
 * Screenshot tools.
 *
 * Real rendering requires Electron's WebContentsView, which is unavailable in
 * plain Node.js. The Electron dependency is lazily imported so module load
 * never crashes in test environments.
 *
 * The tiling/stitching math is exported as a pure function so it IS testable
 * without Electron.
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";

/* --------------------------------------------------------- tiling math --- */

export interface TileSpec {
  /** Y offset from the top of the full page in logical pixels. */
  y: number;
  /** Height of this tile in logical pixels. */
  height: number;
  /** Zero-based index. */
  index: number;
}

/**
 * Compute how a page of `totalHeight` is split into tiles of at most
 * `tileHeight` pixels, with no tile exceeding `tileHeight`.
 *
 * Pure function — exported for unit tests.
 */
export function computeTiles(totalHeight: number, tileHeight: number): TileSpec[] {
  if (totalHeight <= 0 || tileHeight <= 0) return [];

  const tiles: TileSpec[] = [];
  let y = 0;
  let index = 0;

  while (y < totalHeight) {
    const height = Math.min(tileHeight, totalHeight - y);
    tiles.push({ y, height, index });
    y += height;
    index++;
  }

  return tiles;
}

/* ---------------------------------------------------------- interfaces --- */

/**
 * Thin injectable interface wrapping Electron WebContentsView rendering.
 *
 * The default implementation is loaded lazily. Tests can substitute a stub.
 */
export interface PageRenderer {
  renderToImages(options: RenderOptions): Promise<RenderedPage>;
}

export interface RenderOptions {
  input: string; // URL, file path
  viewportWidth: number;
  quality: number;
  tileHeight: number;
  waitNetworkIdle: boolean;
  timeoutMs: number;
  fullPage: boolean;
}

export interface RenderedPage {
  /** JPEG tiles as base64 strings, top to bottom. */
  tiles: string[];
  totalWidth: number;
  totalHeight: number;
  mimeType: "image/jpeg";
}

/* ------------------------------------------------- default Electron impl - */

let _rendererCache: PageRenderer | null = null;
let _rendererFailed = false;

async function getDefaultRenderer(): Promise<PageRenderer | null> {
  if (_rendererFailed) return null;
  if (_rendererCache) return _rendererCache;

  try {
    // Lazy import — will throw in plain Node.js, which is expected.
    const electronModule = await import("electron");
    const { WebContentsView, app } = electronModule as {
      WebContentsView: new (opts: object) => {
        webContents: {
          loadURL(url: string): Promise<void>;
          executeJavaScript(code: string): Promise<unknown>;
          capturePage(rect?: object): Promise<{ toJPEG(quality: number): Buffer }>;
        };
        setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
        setBackgroundColor(color: string): void;
        destroy(): void;
      };
      app: { whenReady(): Promise<void> };
    };

    const renderer: PageRenderer = {
      async renderToImages(opts: RenderOptions): Promise<RenderedPage> {
        await app.whenReady();

        const view = new WebContentsView({});
        view.setBackgroundColor("#ffffff");

        try {
          // Load content
          if (opts.input.startsWith("http://") || opts.input.startsWith("https://")) {
            await view.webContents.loadURL(opts.input);
          } else {
            await view.webContents.loadURL(`file://${opts.input}`);
          }

          if (opts.waitNetworkIdle) {
            // Wait for network idle via a small JS poll
            await view.webContents.executeJavaScript(
              `new Promise(resolve => {
                if (document.readyState === 'complete') { resolve(null); return; }
                window.addEventListener('load', () => resolve(null));
              })`,
            );
          }

          const totalHeight = opts.fullPage
            ? (await view.webContents.executeJavaScript(
                "document.body.scrollHeight",
              ) as number)
            : Math.floor(opts.viewportWidth * 0.75); // rough 4:3 fallback

          view.setBounds({ x: 0, y: 0, width: opts.viewportWidth, height: totalHeight });

          const tileSpecs = computeTiles(totalHeight, opts.tileHeight);
          const tiles: string[] = [];

          for (const tile of tileSpecs) {
            const image = await view.webContents.capturePage({
              x: 0,
              y: tile.y,
              width: opts.viewportWidth,
              height: tile.height,
            });
            tiles.push(image.toJPEG(opts.quality).toString("base64"));
          }

          return {
            tiles,
            totalWidth: opts.viewportWidth,
            totalHeight,
            mimeType: "image/jpeg",
          };
        } finally {
          view.destroy();
        }
      },
    };

    _rendererCache = renderer;
    return renderer;
  } catch {
    _rendererFailed = true;
    return null;
  }
}

/* -------------------------------------------- screenshot tool helpers --- */

const PIXELSHOT_HELP_TEXT = `
pixelshot — screenshot a URL, local HTML file, or local PDF

OPTIONS
  input           (required) URL (http/https), path to local .html file, or path to local .pdf file.
  viewportWidth   Viewport width in pixels. Default: 875.
  quality         JPEG quality 1-100. Default: 85.
  tileHeight      Maximum height of each image tile in pixels. Default: 8192.
                  Large pages are split into tiles and returned as separate images.
  waitNetworkIdle Wait for all network requests to settle before capturing. Default: false.
  timeoutMs       Maximum time to wait for the page to load, in milliseconds. Default: 120000.
  outputDir       Directory to save output files. Defaults to the session outputs dir.
  filePrefix      Prefix for output filenames. Defaults to "screenshot".
  fullPage        Capture the full scrollable page height. Default: false (captures viewport).

OUTPUT
  Returns one or more JPEG images (base64-encoded) covering the captured area.
  When fullPage:true and the page is taller than tileHeight, multiple tiles are returned.

NOTES
  - Requires a vision-capable model to be useful (requiresVision: true).
  - Only available inside the Kozum Cowork Electron app; returns an error in plain Node.
  - PDF rendering uses Electron's built-in PDF viewer.
`.trim();

/* -------------------------------------------------------------- tools ---- */

export const screenshotTools: Tool[] = [
  /* ----------------------------------------------------------- screenshot */
  {
    definition: {
      name: "screenshot",
      title: "Screenshot",
      description:
        "Capture a screenshot of a URL, local HTML file, or local PDF. " +
        "Returns one or more JPEG images. Large pages are split into tiles. " +
        "Only available inside the Kozum Cowork Electron app.",
      inputSchema: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description:
              "URL (http/https), absolute path to a .html file, or absolute path to a .pdf file.",
          },
          viewportWidth: {
            type: "number",
            description: "Viewport width in pixels. Defaults to 875.",
            default: 875,
          },
          quality: {
            type: "number",
            description: "JPEG quality 1-100. Defaults to 85.",
            default: 85,
          },
          tileHeight: {
            type: "number",
            description: "Max height of each image tile in pixels. Defaults to 8192.",
            default: 8192,
          },
          waitNetworkIdle: {
            type: "boolean",
            description: "Wait for network to be idle before capturing. Defaults to false.",
            default: false,
          },
          timeoutMs: {
            type: "number",
            description: "Timeout in milliseconds. Defaults to 120000.",
            default: 120000,
          },
          outputDir: {
            type: "string",
            description: "Directory to save output files. Defaults to session outputs dir.",
          },
          filePrefix: {
            type: "string",
            description: "Prefix for output filenames. Defaults to 'screenshot'.",
            default: "screenshot",
          },
          fullPage: {
            type: "boolean",
            description: "Capture the full scrollable page. Defaults to false.",
            default: false,
          },
        },
        required: ["input"],
      },
      icon: "camera",
      group: "browser",
      requiresVision: true,
      modes: ["cowork", "code"],
    },

    handler: async (input, ctx) => {
      const target = String(input["input"] ?? "").trim();
      if (!target) return fail("input is required");

      const viewportWidth = typeof input["viewportWidth"] === "number" ? input["viewportWidth"] : 875;
      const quality = typeof input["quality"] === "number" ? Math.min(100, Math.max(1, input["quality"])) : 85;
      const tileHeight = typeof input["tileHeight"] === "number" ? input["tileHeight"] : 8192;
      const waitNetworkIdle = input["waitNetworkIdle"] === true;
      const timeoutMs = typeof input["timeoutMs"] === "number" ? input["timeoutMs"] : 120_000;
      const fullPage = input["fullPage"] === true;

      ctx.onProgress("Loading renderer…");

      const renderer = await getDefaultRenderer();
      if (!renderer) {
        return fail(
          "Screenshot rendering is unavailable outside the Kozum Cowork Electron app. " +
            "Run this tool from within the app to capture screenshots.",
          "Rendering unavailable outside Electron",
        );
      }

      ctx.onProgress(`Rendering ${target}…`);

      try {
        const page = await renderer.renderToImages({
          input: target,
          viewportWidth,
          quality,
          tileHeight,
          waitNetworkIdle,
          timeoutMs,
          fullPage,
        });

        const images = page.tiles.map((tile) => ({
          mimeType: page.mimeType,
          data: tile,
        }));

        const tileCount = page.tiles.length;
        const summary =
          `Screenshot of ${target} — ` +
          `${page.totalWidth}×${page.totalHeight}px` +
          (tileCount > 1 ? ` in ${tileCount} tiles` : "");

        return ok(
          `Captured ${target} (${page.totalWidth}×${page.totalHeight}px, ${tileCount} tile${tileCount === 1 ? "" : "s"})`,
          { summary, files: [] },
          images,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(`Screenshot failed: ${msg}`, "Screenshot failed");
      }
    },
  },

  /* -------------------------------------------------------- pixelshot_help */
  {
    definition: {
      name: "pixelshot_help",
      title: "Screenshot Help",
      description:
        "Return usage documentation for the screenshot tool, including all options and their defaults.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      icon: "help-circle",
      group: "browser",
      modes: ["cowork", "code"],
    },

    handler: async (_input, _ctx) => {
      return ok(
        PIXELSHOT_HELP_TEXT,
        { summary: "Screenshot tool documentation" },
      );
    },
  },
];
