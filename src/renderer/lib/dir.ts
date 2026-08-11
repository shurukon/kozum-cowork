/**
 * Kozum Cowork — text-direction helper.
 *
 * Pure mapping from language code to text direction. Kept separate from the
 * React hook so it can be unit-tested under node:test without a DOM.
 */

/**
 * The languages we treat as RTL. Matched by ISO-639-1 code at the start of
 * the language tag (so "ar-SA", "he-IL", "fa-AF", "ur-PK" all match).
 */
const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

export type Direction = "ltr" | "rtl";

/**
 * Resolve a language code (e.g. "ar", "en", "he-IL", "zh-CN") to the
 * appropriate document direction. Anything not in the RTL set defaults to
 * "ltr".
 */
export function resolveDir(language: string | undefined | null): Direction {
  if (!language) return "ltr";
  const primary = language.toLowerCase().split(/[-_]/)[0] ?? "";
  return RTL_LANGUAGES.has(primary) ? "rtl" : "ltr";
}

export interface LanguageOption {
  value: "en" | "ar";
  label: string;
}
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية" },
] as const;
