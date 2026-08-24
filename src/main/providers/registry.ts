/**
 * ProviderRegistry — adapter selection, model refresh, and key testing.
 */

import type { ModelInfo, ProviderPreset } from "../../shared/types.ts";
import type { ProviderAdapter, ProviderContext } from "./adapter.ts";
import { OpenAiChatAdapter } from "./adapters/openai-chat.ts";
import { AnthropicMessagesAdapter } from "./adapters/anthropic-messages.ts";
import { OpenAiResponsesAdapter } from "./adapters/openai-responses.ts";
import { GeminiAdapter } from "./adapters/gemini.ts";
import { VertexGeminiAdapter } from "./adapters/vertex-gemini.ts";
import { getPreset, resolveBaseUrl } from "./presets.ts";
import { resolveCapabilities } from "./capabilities.ts";
import type { SecretStore } from "../store/secrets.ts";
import type { AppPaths } from "../store/paths.ts";
import { modelsFilePath } from "../store/paths.ts";
import { readJson, writeJson } from "../store/json.ts";

const _openAiChatAdapter = new OpenAiChatAdapter();
const _anthropicMessagesAdapter = new AnthropicMessagesAdapter();
const _openAiResponsesAdapter = new OpenAiResponsesAdapter();
const _geminiAdapter = new GeminiAdapter();
const _vertexGeminiAdapter = new VertexGeminiAdapter();

function modelMatchesPrefix(modelId: string, prefix: string): boolean {
  const normalizedId = modelId.trim().toLowerCase();
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (normalizedId === normalizedPrefix || normalizedId.startsWith(normalizedPrefix)) return true;
  const unqualifiedId = normalizedId.includes("/")
    ? normalizedId.slice(normalizedId.lastIndexOf("/") + 1)
    : normalizedId;
  return unqualifiedId === normalizedPrefix || unqualifiedId.startsWith(normalizedPrefix);
}

export class ProviderRegistry {
  private readonly secrets: SecretStore;
  private readonly appPaths: AppPaths;
  private readonly loadCustomPresets?: () => Promise<ProviderPreset[]>;

  constructor(
    secrets: SecretStore,
    appPaths: AppPaths,
    loadCustomPresets?: () => Promise<ProviderPreset[]>,
  ) {
    this.secrets = secrets;
    this.appPaths = appPaths;
    this.loadCustomPresets = loadCustomPresets;
  }

  /** Resolve built-in and user-defined providers from the persisted settings. */
  async presetFor(providerId: string): Promise<ProviderPreset | undefined> {
    const builtIn = getPreset(providerId);
    if (builtIn) return builtIn;
    const custom = await this.loadCustomPresets?.().catch(() => []) ?? [];
    return custom.find((preset) => preset.id === providerId);
  }

  /**
   * Return the adapter for the given protocol.
   * Throws for protocols not yet implemented rather than silently falling back.
   */
  adapterFor(protocol: string): ProviderAdapter {
    switch (protocol) {
      case "openai-chat":
        return _openAiChatAdapter;
      case "anthropic-messages":
        return _anthropicMessagesAdapter;
      case "openai-responses":
        return _openAiResponsesAdapter;
      case "gemini-generative":
        return _geminiAdapter;
      case "vertex-gemini":
        return _vertexGeminiAdapter;
      default:
        throw new Error(`Unknown protocol: "${protocol}"`);
    }
  }

  /**
   * Adapter for a specific model on a preset. Presets with `protocolRoutes`
   * (split-protocol gateways such as OpenCode Zen) route each model id to the
   * wire protocol its vendor documented; everything else uses the preset's
   * default protocol. All routed protocols share the same baseUrl because
   * adapters append their own path segments (/chat/completions, /responses,
   * /messages).
   */
  protocolForModel(preset: ProviderPreset, modelId: string): ProviderPreset["protocol"] {
    const routes = preset.protocolRoutes;
    if (routes) {
      for (const [protocol, prefixes] of Object.entries(routes) as Array<[ProviderPreset["protocol"], string[] | undefined]>) {
        if (!prefixes) continue;
        if (prefixes.some((prefix) => modelMatchesPrefix(modelId, prefix))) {
          return protocol;
        }
      }
    }
    return preset.protocol;
  }

  adapterForModel(preset: ProviderPreset, modelId: string): ProviderAdapter {
    return this.adapterFor(this.protocolForModel(preset, modelId));
  }

  /** Resolve a valid keyId for a provider, falling back to the first available key. */
  async resolveKeyId(providerId: string, keyId: string | null): Promise<string | null> {
    if (keyId) {
      const entry = await this.secrets.getEntry(keyId);
      if (entry) return keyId;
    }
    const keys = await this.secrets.list(providerId);
    return keys[0]?.id ?? null;
  }

  /** Build a ProviderContext for a specific key. */
  async contextFor(providerId: string, keyId: string, modelId?: string): Promise<ProviderContext> {
    const preset = await this.presetFor(providerId);
    if (!preset) throw new Error(`Unknown provider: "${providerId}"`);

    const entry = await this.secrets.getEntry(keyId);
    if (!entry) throw new Error(`API key "${keyId}" not found`);

    const rawKey = await this.secrets.reveal(keyId);
    if (rawKey === null) throw new Error(`Could not decrypt key "${keyId}"`);

    const protocol = modelId ? this.protocolForModel(preset, modelId) : preset.protocol;
    const baseUrl = resolveBaseUrl(preset, entry.meta, protocol);
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
   * Fetch models from the provider catalogue, reporting a typed warning when
   * the live fetch failed and static fallbacks were used instead.
   *
   * Errors are no longer swallowed silently: `warning` carries the reason so
   * the renderer can toast "Refresh failed: <reason> — showing built-in list".
   * The model list itself always falls back (catalogue → staticModels → cached)
   * so a dropdown is never emptied by an unreachable vendor.
   */
  async refreshModels(providerId: string, keyId: string): Promise<ModelInfo[]> {
    const { models } = await this.refreshModelsDetailed(providerId, keyId);
    return models;
  }

  async refreshModelsDetailed(
    providerId: string,
    keyId: string,
  ): Promise<{ models: ModelInfo[]; warning: string | null }> {
    const preset = await this.presetFor(providerId);
    if (!preset) throw new Error(`Unknown provider: "${providerId}"`);

    let models: ModelInfo[] | null = null;
    let warning: string | null = null;

    // Only attempt live fetch if there's a catalogue endpoint and a key
    if (preset.modelsPath !== null) {
      try {
        const adapter = this.adapterFor(preset.protocol);
        const ctx = await this.contextFor(providerId, keyId);
        models = await adapter.listModels(ctx);
      } catch (e) {
        // Fall through to static models, but surface WHY upstream.
        warning = e instanceof Error ? e.message : String(e);
        models = null;
      }
    }

    if (models === null || models.length === 0) {
      if (models !== null && models.length === 0 && !warning) {
        warning = "the provider catalogue returned no models";
      }
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

    return { models, warning };
  }

  /** Read cached ModelInfo records for a provider, falling back to the preset's static list so dropdowns populate without a key or a refresh. */
  async listModels(providerId: string): Promise<ModelInfo[]> {
    const cachePath = modelsFilePath(this.appPaths, providerId);
    const cached = await readJson<ModelInfo[]>(cachePath, []);
    if (cached.length > 0) return cached;

    const preset = await this.presetFor(providerId);
    const now = Date.now();
    return (preset?.staticModels ?? []).map((id) => {
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

  /**
   * Test a key by attempting a models fetch.
   * Updates status on the SecretStore entry.
   */
  async testKey(keyId: string): Promise<void> {
    const entry = await this.secrets.getEntry(keyId);
    if (!entry) throw new Error(`API key "${keyId}" not found`);

    const preset = await this.presetFor(entry.providerId);
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
