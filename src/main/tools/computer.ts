/**
 * Computer-use tools — drive the Windows desktop via PowerShellComputerBackend.
 *
 * All tools share a ComputerBackend instance injected at construction.
 * PowerShell is NOT referenced here; it lives behind the backend seam in
 * windows.ts, following the same lazy-import / injectable pattern as
 * screenshot.ts and browser.ts.
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";
import type { ComputerBackend } from "../computer/windows.ts";
import { isAppBlocked, BackendUnavailableError } from "../computer/windows.ts";

/* -------------------------------------------------------- error helper ---- */

function computerFail(e: unknown): ReturnType<typeof fail> {
  if (e instanceof BackendUnavailableError) {
    return fail(e.message, "Computer use unavailable outside Windows");
  }
  const msg = e instanceof Error ? e.message : String(e);
  return fail(msg, "Computer use error");
}

/* --------------------------------------------------------- tool factory ---- */

/**
 * Build the full set of computer-use tools.
 *
 * @param backend     The ComputerBackend providing OS-level access.
 * @param getBlocklist Returns the current per-user blocklist (app exe names to
 *                    never interact with). Called fresh on each invocation so
 *                    the user can update the list between tool calls.
 */
export function makeComputerTools(
  backend: ComputerBackend,
  getBlocklist: () => string[],
): Tool[] {
  return [
    /* ---------------------------------------------- computer_screenshot */
    {
      definition: {
        name: "computer_screenshot",
        title: "Computer: Screenshot",
        description:
          "Capture a screenshot of the Windows desktop or a screen region. " +
          "Requires a vision-capable model.",
        inputSchema: {
          type: "object",
          properties: {
            x: {
              type: "integer",
              description: "Left edge of the capture region in screen pixels.",
            },
            y: {
              type: "integer",
              description: "Top edge of the capture region in screen pixels.",
            },
            width: {
              type: "integer",
              description: "Width of the capture region in screen pixels.",
            },
            height: {
              type: "integer",
              description: "Height of the capture region in screen pixels.",
            },
            quality: {
              type: "integer",
              description: "JPEG quality 1-100. Default: 85.",
              default: 85,
            },
          },
          required: [],
        },
        icon: "monitor",
        group: "computer",
        requiresVision: true,
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        ctx.onProgress("Capturing desktop screenshot…");

        const hasRegion =
          typeof input["x"] === "number" &&
          typeof input["y"] === "number" &&
          typeof input["width"] === "number" &&
          typeof input["height"] === "number";

        const region = hasRegion
          ? {
              x: input["x"] as number,
              y: input["y"] as number,
              width: input["width"] as number,
              height: input["height"] as number,
            }
          : undefined;

        const quality = typeof input["quality"] === "number" ? input["quality"] : 85;

        try {
          const result = await backend.capture({ region, quality });
          const desc = region
            ? `region (${region.x},${region.y}) ${region.width}x${region.height}`
            : "full screen";
          return ok(
            `Desktop screenshot captured: ${result.width}x${result.height}px`,
            { summary: `Screenshot ${result.width}x${result.height} — ${desc}` },
            [{ mimeType: result.mimeType, data: result.data }],
          );
        } catch (e) {
          return computerFail(e);
        }
      },
    },

    /* ----------------------------------------------- computer_click */
    {
      definition: {
        name: "computer_click",
        title: "Computer: Click",
        description:
          "Click the mouse at the given screen coordinates. Dangerous: interacts with the live desktop.",
        inputSchema: {
          type: "object",
          properties: {
            x: {
              type: "integer",
              description: "X screen coordinate in pixels.",
            },
            y: {
              type: "integer",
              description: "Y screen coordinate in pixels.",
            },
            button: {
              type: "string",
              description: "Mouse button: left, right, or middle. Default: left.",
              enum: ["left", "right", "middle"],
              default: "left",
            },
          },
          required: ["x", "y"],
        },
        icon: "mouse-pointer",
        group: "computer",
        dangerous: true,
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const x = input["x"] as number;
        const y = input["y"] as number;
        const button = (input["button"] as "left" | "right" | "middle") ?? "left";

        ctx.onProgress(`Clicking ${button} at (${x}, ${y})…`);

        try {
          await backend.clickMouse(button, x, y);
          return ok(`Clicked ${button} at (${x}, ${y})`, {
            summary: `${button} click at (${x}, ${y})`,
          });
        } catch (e) {
          return computerFail(e);
        }
      },
    },

    /* ----------------------------------------------- computer_move */
    {
      definition: {
        name: "computer_move",
        title: "Computer: Move Mouse",
        description:
          "Move the mouse cursor to the given screen coordinates without clicking. Dangerous.",
        inputSchema: {
          type: "object",
          properties: {
            x: {
              type: "integer",
              description: "X screen coordinate in pixels.",
            },
            y: {
              type: "integer",
              description: "Y screen coordinate in pixels.",
            },
          },
          required: ["x", "y"],
        },
        icon: "move",
        group: "computer",
        dangerous: true,
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const x = input["x"] as number;
        const y = input["y"] as number;
        ctx.onProgress(`Moving mouse to (${x}, ${y})…`);

        try {
          await backend.moveMouse(x, y);
          return ok(`Mouse moved to (${x}, ${y})`, { summary: `Mouse at (${x}, ${y})` });
        } catch (e) {
          return computerFail(e);
        }
      },
    },

    /* ----------------------------------------------- computer_type */
    {
      definition: {
        name: "computer_type",
        title: "Computer: Type",
        description:
          "Type text into the currently focused window using keyboard events. Dangerous.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to type.",
            },
          },
          required: ["text"],
        },
        icon: "type",
        group: "computer",
        dangerous: true,
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const text = String(input["text"] ?? "");

        // Blocklist check — prevent typing into blocked apps.
        try {
          const active = await backend.activeWindow();
          if (active && isAppBlocked(active.processName, getBlocklist())) {
            return fail(
              `Blocked: "${active.processName}" is on the computer-use blocklist. ` +
                "Remove it from Settings > Computer Use > Blocked Apps to allow interaction.",
              `Blocked: ${active.processName}`,
            );
          }
        } catch {
          // If we cannot determine the active window, proceed (fail-open for
          // cases where activeWindow itself throws BackendUnavailableError
          // and we want a better error from typeText).
        }

        ctx.onProgress(`Typing ${text.length} characters…`);

        try {
          await backend.typeText(text);
          return ok(`Typed ${text.length} character(s)`, {
            summary: `Typed ${text.length} chars`,
          });
        } catch (e) {
          return computerFail(e);
        }
      },
    },

    /* ----------------------------------------------- computer_key */
    {
      definition: {
        name: "computer_key",
        title: "Computer: Press Keys",
        description:
          "Press one or more keyboard keys or key combinations (e.g. ['ctrl','c']). Dangerous.",
        inputSchema: {
          type: "object",
          properties: {
            keys: {
              type: "array",
              description:
                "Array of key names to press as a chord. " +
                "Examples: ['enter'], ['ctrl','c'], ['alt','f4'].",
              items: { type: "string" },
            },
          },
          required: ["keys"],
        },
        icon: "command",
        group: "computer",
        dangerous: true,
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const keys = (input["keys"] as string[]) ?? [];
        const chord = keys.join("+");
        ctx.onProgress(`Pressing ${chord}…`);

        try {
          await backend.pressKeys(keys);
          return ok(`Pressed ${chord}`, { summary: `Keys: ${chord}` });
        } catch (e) {
          return computerFail(e);
        }
      },
    },

    /* ----------------------------------------------- computer_screen_size */
    {
      definition: {
        name: "computer_screen_size",
        title: "Computer: Screen Size",
        description: "Get the width and height of the primary screen in pixels.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        icon: "maximize",
        group: "computer",
        modes: ["cowork", "code"],
      },

      handler: async (_input, ctx) => {
        ctx.onProgress("Querying screen size…");
        try {
          const size = await backend.screenSize();
          return ok(`Screen: ${size.width}x${size.height}px`, {
            summary: `${size.width}x${size.height}`,
          });
        } catch (e) {
          return computerFail(e);
        }
      },
    },

    /* --------------------------------------------- computer_list_windows */
    {
      definition: {
        name: "computer_list_windows",
        title: "Computer: List Windows",
        description: "List all visible top-level windows on the desktop.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        icon: "layout-grid",
        group: "computer",
        modes: ["cowork", "code"],
      },

      handler: async (_input, ctx) => {
        ctx.onProgress("Listing windows…");
        try {
          const windows = await backend.listWindows();
          const lines = windows.map(
            (w) => `${w.title} [${w.processName}] handle=${w.handle}`,
          );
          const content =
            windows.length === 0 ? "No visible windows found." : lines.join("\n");
          return ok(content, { summary: `${windows.length} window(s)` });
        } catch (e) {
          return computerFail(e);
        }
      },
    },
  ];
}
