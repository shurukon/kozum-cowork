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

/**
 * Fail-CLOSED blocklist check.
 *
 * If `activeWindow()` throws for any reason (including the $pid→$procId PS
 * bug that has been fixed, or a genuine BackendUnavailableError), we refuse
 * the action rather than proceeding blind.  The caller is told why so the
 * user can diagnose the problem rather than seeing a mysterious failure later.
 *
 * Returns null when the action is permitted, or a `fail()` result when it
 * should be blocked.
 */
async function checkBlocklist(
  backend: ComputerBackend,
  blocklist: string[],
): Promise<ReturnType<typeof fail> | null> {
  // If the blocklist is empty there is nothing to enforce — skip the PS call.
  if (blocklist.length === 0) return null;

  let active: Awaited<ReturnType<ComputerBackend["activeWindow"]>>;
  try {
    active = await backend.activeWindow();
  } catch (e) {
    // Cannot determine the active window → refuse with explanation.
    const reason = e instanceof Error ? e.message : String(e);
    return fail(
      `Blocked: the active window could not be determined (${reason}). ` +
        "Computer-use is fail-closed when the blocklist is non-empty: " +
        "resolve the backend error or clear the blocklist in Settings.",
      "Blocked: active window unknown",
    );
  }

  if (active === null) {
    // No foreground window returned by the OS.  Refuse conservatively.
    return fail(
      "Blocked: no foreground window detected. " +
        "Computer-use is fail-closed when the blocklist is non-empty.",
      "Blocked: no active window",
    );
  }

  if (isAppBlocked(active.processName, blocklist)) {
    return fail(
      `Blocked: "${active.processName}" is on the computer-use blocklist. ` +
        "Remove it from Settings > Computer Use > Blocked Apps to allow interaction.",
      `Blocked: ${active.processName}`,
    );
  }

  return null;
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
        // Screenshot of a blocked app leaks sensitive screen content.
        const blocked = await checkBlocklist(backend, getBlocklist());
        if (blocked) return blocked;

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

        const blocked = await checkBlocklist(backend, getBlocklist());
        if (blocked) return blocked;

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

        // Blocklist check — fail CLOSED: if we cannot determine the active
        // window, refuse rather than proceeding blind.
        const blocked = await checkBlocklist(backend, getBlocklist());
        if (blocked) return blocked;

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

        const blocked = await checkBlocklist(backend, getBlocklist());
        if (blocked) return blocked;

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
