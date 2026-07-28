/**
 * Kozum Cowork — theme + motion + chat-font applicator hook.
 *
 * Keeps document.documentElement dataset attributes in sync with the user's
 * preferences. All three attributes (data-theme, data-motion, data-font) are
 * applied here so the logic is co-located and easy to test.
 *
 * The pure helper lives in src/renderer/lib/theme.ts so it can be
 * unit-tested without a React runtime.
 */

import { useEffect } from "react";
import type { AppSettings } from "@shared/types.ts";
import { resolveTheme } from "../lib/theme.ts";

// Re-export so callers that used to import resolveTheme from here still work.
export { resolveTheme } from "../lib/theme.ts";

/**
 * Apply appearance, motion, and chat-font settings to the document root.
 * Must be called inside a component that re-renders when `settings` changes.
 */
export function useTheme(settings: AppSettings | null): void {
  const appearance = settings?.general.appearance ?? "dark";
  const motion = settings?.general.motion ?? "system";
  const chatFont = settings?.general.chatFont ?? "sans";

  useEffect(() => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = resolveTheme(appearance, prefersDark);
  }, [appearance]);

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  useEffect(() => {
    document.documentElement.dataset.font = chatFont;
  }, [chatFont]);
}
