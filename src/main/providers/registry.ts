/**
 * ProviderRegistry — adapter selection, model refresh, and key testing.
 */

import type { ModelInfo } from "../../shared/types.ts";
import type { ProviderAdapter, ProviderContext } from "./adapter.ts";
import { OpenAiChatAdapter } from "./adapters/openai-chat.ts";
import { getPreset, resolveBaseUrl } from "./presets.ts";
import { resolveCapabilities } from "./capabilities.ts";
import type { SecretStore } from "../store/secrets.ts";
import type { AppPaths } from "../store/paths.ts";
import { modelsFilePath } from "../store/paths.ts";
import { readJson, writeJson } from "../store/json.ts";

const _openAiChatAdapter = new OpenAiChatAdapter();

export class ProviderRegistry {
  private readonly secrets: SecretStore;
  private readonly appPaths: AppPaths;

  constructor(secrets: SecretStore, appPaths: AppPaths) {
    this.secrets = secrets;
    this.appPaths = appPaths;
  }

  /**
   * Return the adapter for the given protocol.
   * Throws for protocols not yet implemented rather than silently falling back.
   */
  adapterFor(protocol: string): ProviderAdapter {
    if (protocol === "openai-chat") {
      return _openAiChatAdapter;
    }

    const unimplemented = [
      "anthropic-messages",
      "openai-responses",
      "gemini-generative",
      "vertex-gemini",
    ];
    if (unimplemented.includes(protocol)) {
      throw new Error(
        `Protocol "${protocol}" is not yet implemented. ` +
          `Only "openai-chat" is currently supported. ` +
          `Using an unimplemented adapter would produce confusing 400 errors.`,
      );
    }

    throw new Error(`Unknown protocol: "${protocol}"`);
  }

  /** Build a ProviderContext for a specific key. */
  async contextFor(providerId: string, keyId: string): Promise<ProviderContext> {
    const preset = getPreset(providerId);
    if (!preset) throw new Error(`Unknown provider: "${providerId}"`);

    const entry = await this.secrets.getEntry(keyId);
    if (!entry) throw new Error(`API key "${keyId}" not found`);

    const rawKey = await this.secrets.reveal(keyId);
    if (rawKey === null) throw new Error(`Could not decrypt key "${keyId}"`);

    const baseUrl = resolveBaseUrl(preset, entry.meta);
    const extraHeaders: Record<string, string> = { ...(preset.defaultHeaders ?? {}) };

    return {
      providerId,
      baseUrl,
      apiKey: rawKey,
      meta: entry.meta ?? {},
      extraHeaders,
    };
  }

  /**
   * Fetch models from the provider catalogue. Falls back to staticModels when
   * the adapter returns null. Caches result to disk.
   */
  async refreshModels(providerId: string, keyId: string): Promise<ModelInfo[]> {
    const preset = getPreset(providerId);
    if (!preset) throw new Error(`Unknown provider: "${providerId}"`);

    let models: ModelInfo[] | null = null;

    // Only attempt live fetch if there's a catalogue endpoint and a key
    if (preset.modelsPath !== null) {
      try {
        const adapter = this.adapterFor(preset.protocol);
        const ctx = await this.contextFor(providerId, keyId);
        models = await adapter.listModels(ctx);
      } catch {
        // Fall through to static models
        models = null;
      }
    }

    if (models === null) {
      // Use static models from preset
      const now = Date.now();
      models = (preset.staticModels ?? []).map((id) => {
        const { capabilities, inferred } = resolveCapabilities(id, providerId);
        return {
          id,
          displayName: id,
          providerId,
          capabilities,
          fetchedAt: now,
          capabilitiesInferred: inferred,
        } satisfies ModelInfo;
      });
    }

    // Cache to disk
    const cachePath = modelsFilePath(this.appPaths, providerId);
    await writeJson(cachePath, models).catch(() => undefined);

    return models;
  }

  /** Read cached ModelInfo records for a provider. */
  async listModels(providerId: string): Promise<ModelInfo[]> {
    const cachePath = modelsFilePath(this.appPaths, providerId);
    return readJson<ModelInfo[]>(cachePath, []);
  }

  /**
   * Test a key by attempting a models fetch.
   * Updates status on the SecretStore entry.
   */
  async testKey(keyId: string): Promise<void> {
    const entry = await this.secrets.getEntry(keyId);
    if (!entry) throw new Error(`API key "${keyId}" not found`);

    const preset = getPreset(entry.providerId);
    if (!preset) {
      await this.secrets.setStatus(keyId, "error", `Unknown provider: ${entry.providerId}`);
      return;
    }

    try {
      const adapter = this.adapterFor(preset.protocol);
      const ctx = await this.contextFor(entry.providerId, keyId);
      await adapter.listModels(ctx);
      await this.secrets.setStatus(keyId, "valid");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A 401/403 is "invalid", other errors are "error"
      const isInvalid = msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("Forbidden");
      await this.secrets.setStatus(keyId, isInvalid ? "invalid" : "error", msg);
    }
  }
}
