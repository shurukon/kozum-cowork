/**
 * SettingsStore — persisted application settings.
 *
 * Wraps freshSettings() with atomic persistence. patch() deep-merges one level
 * into each top-level section so callers can update e.g. general.userName
 * without touching general.language.
 */

import type { AppSettings } from "../../shared/types.ts";
import { freshSettings } from "../../shared/defaults.ts";
import { readJson, writeJson } from "./json.ts";

export class SettingsStore {
  private readonly filePath: string;
  private data: AppSettings;
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = freshSettings();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const saved = await readJson<Partial<AppSettings>>(this.filePath, {});
    // Merge saved values over factory defaults.
    this.data = deepMerge(freshSettings(), saved) as AppSettings;
  }

  async get(): Promise<AppSettings> {
    await this.ensureLoaded();
    return structuredClone(this.data);
  }

  /**
   * Deep-merge `patch` one level deep into each top-level section.
   * Returns the new full settings.
   */
  async patch(partial: Partial<AppSettings>): Promise<AppSettings> {
    await this.ensureLoaded();
    this.data = deepMerge(this.data, partial) as AppSettings;
    await writeJson(this.filePath, this.data);
    return structuredClone(this.data);
  }
}

/**
 * Deep-merge `src` into `target` one level per key.
 * - For object-valued keys: merges the sub-objects (flat, no recursion beyond one level).
 * - For other values: overwrites.
 */
function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(src)) {
    const sv = src[key];
    const tv = target[key];
    if (
      sv !== null &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = { ...(tv as object), ...(sv as object) };
    } else {
      result[key] = sv;
    }
  }
  return result;
}
