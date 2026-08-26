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
  private readonly loadProviderOverrides?: () => Promise<Record<string, { agentRouterMode?: "auto" | "openai" | "anthropic" }>>;

  constructor(
    secrets: SecretStore,
    appPaths: AppPaths,
    loadCustomPresets?: () => Promise<ProviderPreset[]>,
    loadProviderOverrides?: () => Promise<Record<string, { agentRouterMode?: "auto" | "openai" | "anthropic" }>>,
  ) {
    this.secrets = secrets;
    this.appPaths = appPaths;
    this.loadCustomPresets = loadCustomPresets;
    this.loadProviderOverrides = loadProviderOverrides;
  }

  /** Resolve built-in and user-defined providers from the persisted settings. */
  async presetFor(providerId: string): Promise<ProviderPreset | undefined> {
    const builtIn = getPreset(providerId);
    if (builtIn) {
      // Apply stored providerOverrides (e.g. AgentRouter explicit mode) without mutating the shipped preset.
      if (this.loadProviderOverrides) {
        try {
          const overrides = await this.loadProviderOverrides();
          const ov = overrides[providerId];
          if (ov && typeof ov.agentRouterMode === "string") {
            return { ...builtIn, agentRouterMode: ov.agentRouterMode as ProviderPreset["agentRouterMode"] };
          }
        } catch {
          /* ignore override load failure */
        }
      }
      return builtIn;
    }
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
   *
   * For AgentRouter, an explicit `agentRouterMode` overrides prefix inference.
   * When forced, a mismatched model family throws a diagnostic error instead of
   * silently falling back to the wrong wire format.
   */
  protocolForModel(preset: ProviderPreset, modelId: string): ProviderPreset["protocol"] {
    // AgentRouter explicit mode takes precedence over prefix inference.
    if (preset.id === "agentrouter" && preset.agentRouterMode && preset.agentRouterMode !== "auto") {
      const forced = preset.agentRouterMode === "anthropic" ? "anthropic-messages" : "openai-chat";
      // Validate compatibility: give a clear error instead of silent fallback.
      const isClaudeModel = modelMatchesPrefix(modelId, "claude-");
      const isOpenAiFamily = ["gpt-", "kimi-", "glm-", "deepseek-", "minimax-", "qwen-"].some((p) => modelMatchesPrefix(modelId, p));
      if (preset.agentRouterMode === "anthropic" && !isClaudeModel) {
        throw new Error(
          `AgentRouter mode "Claude (Anthropic)" expects a claude- model but got "${modelId}". Switch AgentRouter mode to Auto or Kilo (OpenAI) or pick a claude- model.`,
        );
      }
      if (preset.agentRouterMode === "openai" && isClaudeModel) {
        throw new Error(
          `AgentRouter mode "Kilo (OpenAI)" expects an OpenAI-compatible model (gpt-/kimi-/glm-/...) but got "${modelId}". Switch AgentRouter mode to Auto or Claude (Anthropic) or pick a compatible model.`,
        );
      }
      if (preset.agentRouterMode === "openai" && !isOpenAiFamily && !isClaudeModel) {
        // Unknown family still allowed through openai-chat — provider will decide. No error.
      }
      return forced as ProviderPreset["protocol"];
    }
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

    const rawKey = (await this.secrets.reveal(keyId)) ?? "";
    if (!rawKey) throw new Error(`Could not decrypt key "${keyId}"`);

    // HTTP headers must be ByteStrings: reject keys with non-ASCII/control
    // characters (typical copy-paste artifact from chat/RTL text) with an
    // actionable message instead of an opaque fetch failure later.
    const trimmed = rawKey.trim();
    if (!trimmed || !/^[\x21-\x7E]+$/.test(trimmed)) {
      await this.secrets.setStatus(keyId, "invalid", "key contains invalid characters");
      throw new Error(
        `The stored API key for provider "${preset.name}" contains invalid characters ` +
          `(non-ASCII or spaces). This usually happens when the key is copied with ` +
          `extra text. Remove it from Settings → AI providers and paste it again.`,
      );
    }

    const protocol = modelId ? this.protocolForModel(preset, modelId) : preset.protocol;
    const baseUrl = resolveBaseUrl(preset, entry.meta, protocol);
    const extraHeaders: Record<string, string> = { ...(preset.defaultHeaders ?? {}) };

    return {
      providerId,
      baseUrl,
      apiKey: trimmed,
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
        // Fall through to static models, but surface WHY upstream — with an
        // actionable hint for auth failures, which are the common case.
        const raw = e instanceof Error ? e.message : String(e);
        if (/401|unauthorized/i.test(raw)) {
          warning =
            `401 from ${preset.name} — the stored API key was rejected. ` +
            `Remove and re-add it in Settings → AI providers, then refresh again.`;
        } else {
          warning = raw;
        }
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
