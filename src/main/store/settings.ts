/**
 * SettingsStore — persisted application settings.
 *
 * Wraps freshSettings() with atomic persistence. patch() deep-merges one level
 * into each top-level section so callers can update e.g. general.userName
 * without touching general.language.
 */

import type { AppSettings, ProviderPreset } from "../../shared/types.ts";
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
    // Merge saved values over factory defaults, then normalize the custom
    // provider records written by older builds. Secrets intentionally remain in
    // SecretStore; settings migration never reads or copies raw API keys.
    this.data = normalizeSettings(deepMerge(freshSettings(), saved));
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
    this.data = deepMerge(this.data, partial);
    await writeJson(this.filePath, this.data);
    return structuredClone(this.data);
  }
}

/**
 * Deep-merge `src` into `target` one level per key.
 * - For object-valued keys: merges the sub-objects (flat, no recursion beyond one level).
 * - For other values: overwrites.
 */
/**
 * Deep-merge one level of nested objects, preserving the target's type.
 *
 * Generic rather than Record-typed: a TypeScript interface has no index
 * signature, so AppSettings is not assignable to Record<string, unknown> under
 * strict mode, and casting at every call site is noisier than casting once here.
 */
function normalizeSettings(settings: AppSettings): AppSettings {
  const customProviders = Array.isArray(settings.customProviders)
    ? settings.customProviders.map((provider) => {
        const legacy = provider as ProviderPreset & { modelIds?: unknown };
        const models = Array.isArray(provider.staticModels)
          ? provider.staticModels.map(String).map((model) => model.trim()).filter(Boolean)
          : Array.isArray(legacy.modelIds)
            ? legacy.modelIds.map(String).map((model) => model.trim()).filter(Boolean)
            : [];
        const normalized: ProviderPreset = {
          ...provider,
          staticModels: models,
          builtIn: false,
        };
        delete (normalized as ProviderPreset & { modelIds?: unknown }).modelIds;
        return normalized;
      })
    : [];
  const providerOverrides =
    settings.providerOverrides && typeof settings.providerOverrides === "object" && !Array.isArray(settings.providerOverrides)
      ? settings.providerOverrides
      : {};
  // Only keep known agentRouterMode values
  const sanitizedOverrides: typeof providerOverrides = {};
  for (const [k, v] of Object.entries(providerOverrides as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      const mode = (v as { agentRouterMode?: unknown }).agentRouterMode;
      if (mode === "auto" || mode === "openai" || mode === "anthropic") {
        sanitizedOverrides[k] = { agentRouterMode: mode };
      }
    }
  }
  // Legacy "custom" escape hatch was removed (2026-08-25). Any selection still
  // pointing at it can never resolve; reset it so the resolver guides the user
  // to Settings → AI providers → Add provider instead of failing opaquely.
  const stripLegacyCustom = (sel: AppSettings["cowork"]["selection"]): AppSettings["cowork"]["selection"] =>
    sel?.providerId === "custom" ? { providerId: "", keyId: null, modelId: "" } : sel;
  const cowork = settings.cowork
    ? { ...settings.cowork, selection: stripLegacyCustom(settings.cowork.selection) }
    : settings.cowork;
  const code = settings.code
    ? { ...settings.code, selection: stripLegacyCustom(settings.code.selection) }
    : settings.code;
  return { ...settings, customProviders, providerOverrides: sanitizedOverrides, cowork, code };
}

function deepMerge<T extends object>(target: T, src: Partial<T>): T {
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  const srcRec = src as Record<string, unknown>;
  const tgtRec = target as Record<string, unknown>;
  for (const key of Object.keys(srcRec)) {
    const sv = srcRec[key];
    const tv = tgtRec[key];
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
  return result as T;
}
