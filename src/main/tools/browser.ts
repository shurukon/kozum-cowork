/**
 * Browser tools — drive Kozum's internal Chromium session.
 *
 * All tools share a single BrowserEngine instance injected at construction.
 * Electron is NOT imported here; it is encapsulated behind BrowserEngine/
 * ElectronBrowserBackend in engine.ts, which follows the same lazy-import
 * pattern as screenshot.ts.
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";
import type { BrowserEngine } from "../browser/engine.ts";
import { BackendUnavailableError } from "../browser/engine.ts";

/* -------------------------------------------------------- error helper ---- */

function browserFail(e: unknown): ReturnType<typeof fail> {
  if (e instanceof BackendUnavailableError) {
    return fail(e.message, "Browser unavailable outside Electron");
  }
  const msg = e instanceof Error ? e.message : String(e);
  return fail(msg, "Browser error");
}

/* --------------------------------------------------------- tool factory ---- */

/**
 * Build the full set of browser tools around a shared BrowserEngine.
 * Call this once per session (the engine holds the session state).
 */
export function makeBrowserTools(engine: BrowserEngine): Tool[] {
  return [
    /* ---------------------------------------------------- browser_navigate */
    {
      definition: {
        name: "browser_navigate",
        title: "Browser: Navigate",
        description:
          "Navigate the internal browser to a URL. " +
          "Supports http, https, file, and about:blank. " +
          "javascript:, data:, and vbscript: URLs are blocked.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL to navigate to (http/https/file/about:blank).",
            },
          },
          required: ["url"],
        },
        icon: "compass",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const url = String(input["url"] ?? "").trim();
        ctx.onProgress(`Navigating to ${url}…`);
        try {
          await engine.navigate(url);
          const current = await engine.currentUrl();
          return ok(`Navigated to ${current}`, { summary: `Navigated to ${current}` });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* ------------------------------------------------------- browser_click */
    {
      definition: {
        name: "browser_click",
        title: "Browser: Click",
        description:
          "Click an element in the browser by CSS selector, or by x/y pixel coordinates.",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector of the element to click.",
            },
            x: {
              type: "number",
              description: "X pixel coordinate (used when selector is omitted).",
            },
            y: {
              type: "number",
              description: "Y pixel coordinate (used when selector is omitted).",
            },
          },
          required: [],
        },
        icon: "mouse-pointer-click",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const selector = typeof input["selector"] === "string" ? input["selector"].trim() : "";
        const x = typeof input["x"] === "number" ? input["x"] : undefined;
        const y = typeof input["y"] === "number" ? input["y"] : undefined;

        if (!selector && (x === undefined || y === undefined)) {
          return fail("browser_click requires either selector or both x and y.");
        }

        const target = selector || `(${x!}, ${y!})`;
        ctx.onProgress(`Clicking ${target}…`);

        try {
          if (selector) {
            await engine.click(selector);
          } else {
            await engine.click({ x: x!, y: y! });
          }
          return ok(`Clicked ${target}`, { summary: `Clicked ${target}` });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* -------------------------------------------------------- browser_type */
    {
      definition: {
        name: "browser_type",
        title: "Browser: Type",
        description: "Type text into a form field identified by a CSS selector.",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector of the input element.",
            },
            text: {
              type: "string",
              description: "Text to type into the element.",
            },
            submit: {
              type: "boolean",
              description: "Whether to press Enter after typing. Default: false.",
              default: false,
            },
          },
          required: ["selector", "text"],
        },
        icon: "keyboard",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const selector = String(input["selector"] ?? "").trim();
        const text = String(input["text"] ?? "");
        const submit = input["submit"] === true;

        ctx.onProgress(`Typing into ${selector}…`);

        try {
          await engine.type(selector, text);
          if (submit) {
            await engine.evaluate(
              `(function(){` +
                ` var el = document.querySelector(${JSON.stringify(selector)});` +
                ` if (el) { var f = el.closest('form'); if (f) f.submit(); else el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); }` +
                `})()`,
            );
          }
          return ok(`Typed into ${selector}`, { summary: `Typed into ${selector}` });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* ------------------------------------------------------ browser_scroll */
    {
      definition: {
        name: "browser_scroll",
        title: "Browser: Scroll",
        description: "Scroll the current page up, down, left, or right.",
        inputSchema: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              description: "Direction to scroll: up, down, left, or right.",
              enum: ["up", "down", "left", "right"],
            },
            amount: {
              type: "number",
              description: "Pixels to scroll. Default: 400.",
              default: 400,
            },
          },
          required: ["direction"],
        },
        icon: "move-vertical",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const direction = String(input["direction"] ?? "down") as
          | "up"
          | "down"
          | "left"
          | "right";
        const amount = typeof input["amount"] === "number" ? input["amount"] : 400;

        ctx.onProgress(`Scrolling ${direction} ${amount}px…`);

        try {
          await engine.scroll(direction, amount);
          return ok(`Scrolled ${direction} ${amount}px`, {
            summary: `Scrolled ${direction} ${amount}px`,
          });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* -------------------------------------------------- browser_screenshot */
    {
      definition: {
        name: "browser_screenshot",
        title: "Browser: Screenshot",
        description:
          "Capture a screenshot of the current browser page. " +
          "Requires a vision-capable model.",
        inputSchema: {
          type: "object",
          properties: {
            fullPage: {
              type: "boolean",
              description: "Capture the full scrollable page. Default: false.",
              default: false,
            },
          },
          required: [],
        },
        icon: "camera",
        group: "browser",
        requiresVision: true,
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const fullPage = input["fullPage"] === true;
        ctx.onProgress("Capturing screenshot…");

        try {
          const result = await engine.screenshot({ fullPage, quality: 85 });
          const summary = `Browser screenshot ${result.width}x${result.height}`;
          return ok(
            `Screenshot captured (${result.width}x${result.height}px)`,
            { summary },
            [{ mimeType: result.mimeType, data: result.data }],
          );
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* ---------------------------------------------------- browser_extract */
    {
      definition: {
        name: "browser_extract",
        title: "Browser: Extract",
        description:
          "Extract structured data from the current page based on a plain-language instruction.",
        inputSchema: {
          type: "object",
          properties: {
            instruction: {
              type: "string",
              description: "What to extract from the page (plain language).",
            },
            schema: {
              type: "object",
              description: "Optional JSON schema describing the expected output shape.",
            },
          },
          required: ["instruction"],
        },
        icon: "braces",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const instruction = String(input["instruction"] ?? "").trim();
        ctx.onProgress("Extracting data…");

        try {
          const raw = await engine.extract(instruction);
          const json = JSON.stringify(raw, null, 2);
          return ok(json, { summary: `Extracted: ${instruction.slice(0, 80)}` });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* ----------------------------------------------- browser_get_content */
    {
      definition: {
        name: "browser_get_content",
        title: "Browser: Get Content",
        description: "Get the text or HTML content of the current page or a specific element.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "Content type: 'text' or 'html'. Default: text.",
              enum: ["text", "html"],
              default: "text",
            },
            selector: {
              type: "string",
              description:
                "CSS selector to scope the content to. Defaults to the whole page.",
            },
          },
          required: [],
        },
        icon: "file-code",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const type = String(input["type"] ?? "text") as "text" | "html";
        const selector = typeof input["selector"] === "string" ? input["selector"].trim() : "";

        ctx.onProgress("Fetching page content…");

        try {
          let content: string;

          if (type === "html") {
            if (selector) {
              content = (await engine.evaluate(
                `(function(){` +
                  ` var el = document.querySelector(${JSON.stringify(selector)});` +
                  ` return el ? el.outerHTML : null;` +
                  `})()`,
              )) as string ?? "";
            } else {
              content = await engine.content();
            }
          } else {
            if (selector) {
              content = (await engine.evaluate(
                `(function(){` +
                  ` var el = document.querySelector(${JSON.stringify(selector)});` +
                  ` return el ? (el.innerText || el.textContent || '') : null;` +
                  `})()`,
              )) as string ?? "";
            } else {
              content = (await engine.evaluate(
                "document.body ? (document.body.innerText || document.body.textContent || '') : ''",
              )) as string;
            }
          }

          const length = content?.length ?? 0;
          return ok(content ?? "", { summary: `Retrieved ${type} content (${length} chars)` });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* ------------------------------------------------------- browser_wait */
    {
      definition: {
        name: "browser_wait",
        title: "Browser: Wait",
        description:
          "Wait for a CSS selector to appear in the DOM, or wait for a fixed number of milliseconds.",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector to wait for.",
            },
            milliseconds: {
              type: "number",
              description: "Number of milliseconds to wait (used when selector is omitted).",
            },
          },
          required: [],
        },
        icon: "hourglass",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (input, ctx) => {
        const selector = typeof input["selector"] === "string" ? input["selector"].trim() : "";
        const ms = typeof input["milliseconds"] === "number" ? input["milliseconds"] : undefined;

        if (!selector && ms === undefined) {
          return fail("browser_wait requires either selector or milliseconds.");
        }

        const desc = selector ? `selector "${selector}"` : `${ms}ms`;
        ctx.onProgress(`Waiting for ${desc}…`);

        try {
          await engine.waitFor(selector || ms!);
          return ok(`Done waiting for ${desc}`, { summary: `Waited for ${desc}` });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* ------------------------------------------------------- browser_back */
    {
      definition: {
        name: "browser_back",
        title: "Browser: Back",
        description: "Navigate the browser back one step in history.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        icon: "arrow-left",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (_input, ctx) => {
        ctx.onProgress("Going back…");
        try {
          await engine.evaluate("history.back(); true");
          return ok("Navigated back", { summary: "Navigated back" });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* ---------------------------------------------------- browser_forward */
    {
      definition: {
        name: "browser_forward",
        title: "Browser: Forward",
        description: "Navigate the browser forward one step in history.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        icon: "arrow-right",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (_input, ctx) => {
        ctx.onProgress("Going forward…");
        try {
          await engine.evaluate("history.forward(); true");
          return ok("Navigated forward", { summary: "Navigated forward" });
        } catch (e) {
          return browserFail(e);
        }
      },
    },

    /* ------------------------------------------------------- browser_close */
    {
      definition: {
        name: "browser_close",
        title: "Browser: Close",
        description: "Close the current browser session and release its resources.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        icon: "x",
        group: "browser",
        modes: ["cowork", "code"],
      },

      handler: async (_input, ctx) => {
        ctx.onProgress("Closing browser…");
        try {
          await engine.close();
          return ok("Browser session closed.", { summary: "Browser closed" });
        } catch (e) {
          return browserFail(e);
        }
      },
    },
  ];
}
