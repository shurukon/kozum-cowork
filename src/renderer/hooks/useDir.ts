/**
 * Kozum Cowork — direction (RTL/LTR) hook.
 *
 * Sets `document.documentElement.dir` from the user's interface language so
 * Arabic / Hebrew / Persian / Urdu mirror the layout to RTL. Lives in its
 * own hook so useTheme stays focused on theme/motion/font only — and so
 * the "no Arabic/RTL handling remains" guard test can whitelist this one
 * file as the legitimate owner of `documentElement.dir`.
 *
 * Pure helper lives in `lib/dir.ts` so it can be unit-tested without React.
 */

import { useEffect } from "react";
import { resolveDir, type Direction } from "../lib/dir.ts";

/**
 * Apply text-direction to the document root. Must be called inside a
 * component that re-renders when `language` changes.
 */
export function useDir(language: string | undefined | null): void {
  useEffect(() => {
    const dir: Direction = resolveDir(language);
    document.documentElement.dir = dir;
  }, [language]);
}
