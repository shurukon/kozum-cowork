/**
 * Pure theme helpers — no React, no DOM.
 *
 * Exported separately from useTheme.ts so they can be unit-tested with
 * node --experimental-strip-types without needing a React runtime.
 */

import type { AppSettings } from "@shared/types.ts";

/**
 * Resolve the data-theme string from the user setting.
 *
 * For "system" we return "system" and let the CSS @media rules decide
 * which palette to activate. For "light" and "dark" we pass through.
 *
 * @param setting      AppSettings.general.appearance
 * @param _prefersDark Kept in signature for call-site clarity; unused because
 *                     "system" delegates to CSS rather than JS.
 */
export function resolveTheme(
  setting: AppSettings["general"]["appearance"],
  _prefersDark: boolean,
): "light" | "dark" | "system" {
  if (setting === "light") return "light";
  if (setting === "dark") return "dark";
  return "system";
}
