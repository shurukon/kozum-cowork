/**
 * Kozum Cowork — model capability resolution.
 *
 * Capability data is used for one thing above all: deciding whether computer
 * use and screenshot reasoning are allowed. Getting that wrong is expensive in
 * both directions — a false positive means the agent blindly clicks at
 * coordinates it cannot see, and a false negative locks the user out of a
 * feature their model actually supports.
 *
 * So we resolve in three tiers, most trustworthy first:
 *   1. Explicit modality metadata from the provider's own catalogue.
 *   2. A curated table of known model families.
 *   3. Conservative defaults (vision off, tools on).
 *
 * Tier 2 and 3 mark the result `capabilitiesInferred`, which the UI surfaces so
 * the user knows the gate is a guess and can override it.
 */

import type { ModelCapabilities, VisionSupport } from "../../shared/types.ts";

/**
 * Families that accept image input, matched case-insensitively as substrings
 * against the model id. Ordered roughly by how specific the pattern is.
 *
 * Verified 2026-07-28. Anything not matched here is assumed text-only.
 */
const VISION_PATTERNS: RegExp[] = [
  // Anthropic — every Claude 3 and later is multimodal.
  /claude-3/i,
  /claude-(opus|sonnet|haiku)-[45]/i,
  /claude-(opus|fable)-5/i,

  // OpenAI — 4o and later; the o1/o3 mini reasoning models are text-only.
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /chatgpt-4o/i,

  // Google — the whole Gemini line is natively multimodal.
  /gemini/i,

  // MiniMax — M3 is multimodal, M2 is not.
  /minimax[-_]?m3/i,

  // Moonshot — k2.6 and later.
  /kimi-k2\.[6-9]/i,
  /kimi-k[3-9]/i,

  // Zhipu / Z.AI — only the -v variants.
  /glm-4v/i,
  /glm-[5-9](\.\d+)?-v\b/i,
  /glm-.*-vision/i,

  // Meta Llama vision, however the host spells it.
  /llama-?3\.2-(11|90)b-vision/i,
  /llama-4-(scout|maverick)/i,

  // Qwen VL.
  /qwen.*-vl/i,
  /qwen\d*-omni/i,

  // NVIDIA in-house VLMs.
  /nemotron.*-vl/i,

  // Mistral / Pixtral.
  /pixtral/i,

  // Misc open VLMs commonly proxied by gateways.
  /internvl/i,
  /molmo/i,
  /idefics/i,
  /llava/i,
];

/**
 * Providers whose entire current catalogue is text-only. Short-circuits the
 * pattern table and lets us give a precise error message naming the provider
 * rather than the model.
 */
export const TEXT_ONLY_PROVIDERS = new Set(["cerebras", "deepseek"]);

/** Families that cannot do native tool calling, so cannot drive the agent loop. */
const NO_TOOLS_PATTERNS: RegExp[] = [
  /-base$/i,
  /instruct-base/i,
  /embed/i,
  /rerank/i,
  /whisper/i,
  /tts/i,
  /stable-diffusion/i,
  /flux/i,
];

const REASONING_PATTERNS: RegExp[] = [
  /^o[1-9]/i,
  /reasoner/i,
  /-thinking/i,
  /deepseek-r\d/i,
  /qwq/i,
  /glm-[5-9].*-thinking/i,
];

export function looksVisionCapable(modelId: string, providerId?: string): boolean {
  if (providerId && TEXT_ONLY_PROVIDERS.has(providerId)) return false;
  return VISION_PATTERNS.some((re) => re.test(modelId));
}

function looksToolCapable(modelId: string): boolean {
  return !NO_TOOLS_PATTERNS.some((re) => re.test(modelId));
}

function looksReasoning(modelId: string): boolean {
  return REASONING_PATTERNS.some((re) => re.test(modelId));
}

/**
 * Raw catalogue entries differ wildly between vendors. This is the union of the
 * shapes we actually observe, all optional.
 */
export interface RawCatalogueEntry {
  id?: string;
  name?: string;
  display_name?: string;
  description?: string;
  context_length?: number;
  max_completion_tokens?: number;
  /** OpenRouter */
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
    modality?: string;
  };
  top_provider?: { max_completion_tokens?: number; context_length?: number };
  supported_parameters?: string[];
  /** Gemini native */
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  /** Kilo / misc */
  capabilities?: string[] | Record<string, boolean>;
  modalities?: { input?: string[]; output?: string[] };
}

/**
 * Resolve capabilities for one catalogue entry.
 *
 * Returns the capabilities plus whether they had to be inferred, so callers can
 * distinguish "the provider told us this model has vision" from "the id looks
 * like a family that usually does".
 */
export function resolveCapabilities(
  modelId: string,
  providerId: string,
  raw?: RawCatalogueEntry,
): { capabilities: ModelCapabilities; inferred: boolean } {
  let vision: VisionSupport | undefined;
  let tools: boolean | undefined;
  let contextWindow: number | undefined;
  let maxOutputTokens: number | undefined;
  let explicit = false;

  if (raw) {
    // --- OpenRouter and anything else exposing input modalities ---------
    const modalities =
      raw.architecture?.input_modalities ?? raw.modalities?.input ?? undefined;
    if (Array.isArray(modalities) && modalities.length > 0) {
      vision = modalities.some((m) => /image|vision/i.test(m)) ? "yes" : "no";
      explicit = true;
    } else if (typeof raw.architecture?.modality === "string") {
      // Older OpenRouter shape: "text+image->text".
      vision = /image/i.test(raw.architecture.modality) ? "yes" : "no";
      explicit = true;
    }

    // --- generic capability arrays / maps --------------------------------
    if (vision === undefined && raw.capabilities) {
      if (Array.isArray(raw.capabilities)) {
        const caps = raw.capabilities.map((c) => String(c).toLowerCase());
        if (caps.some((c) => /vision|image|multimodal/.test(c))) {
          vision = "yes";
          explicit = true;
        }
        if (caps.some((c) => /tool|function/.test(c))) tools = true;
      } else {
        const m = raw.capabilities as Record<string, boolean>;
        if ("vision" in m) {
          vision = m.vision ? "yes" : "no";
          explicit = true;
        }
        if ("tools" in m) tools = Boolean(m.tools);
      }
    }

    if (Array.isArray(raw.supported_parameters)) {
      tools = raw.supported_parameters.includes("tools");
    }

    contextWindow =
      raw.context_length ?? raw.top_provider?.context_length ?? raw.inputTokenLimit;
    maxOutputTokens =
      raw.max_completion_tokens ??
      raw.top_provider?.max_completion_tokens ??
      raw.outputTokenLimit;
  }

  // Provider-wide override always wins: if the vendor ships no vision models
  // at all, a hopeful pattern match must not unlock computer use.
  if (TEXT_ONLY_PROVIDERS.has(providerId)) {
    vision = "no";
    explicit = true;
  }

  const inferredVision = vision === undefined;
  if (vision === undefined) {
    // No metadata. A name match is strong evidence for "yes"; the absence of
    // one is weak evidence for "no", so it resolves to "unknown" and the agent
    // is allowed to try. See VisionSupport for why this matters.
    vision = looksVisionCapable(modelId, providerId) ? "yes" : "unknown";
  }
  if (tools === undefined) tools = looksToolCapable(modelId);

  return {
    capabilities: {
      vision,
      tools,
      streaming: true,
      reasoning: looksReasoning(modelId),
      contextWindow,
      maxOutputTokens,
    },
    inferred: inferredVision && !explicit,
  };
}

/**
 * Suggestions offered when the user tries to do something visual on a
 * text-only model. Ordered by how easy each is to actually reach — the free
 * options come first.
 */
export const VISION_FALLBACK_SUGGESTIONS: Array<{
  providerId: string;
  modelId: string;
  label: string;
  free: boolean;
}> = [
  {
    providerId: "google-ai-studio",
    modelId: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    free: true,
  },
  {
    providerId: "nvidia-nim",
    modelId: "meta/llama-3.2-90b-vision-instruct",
    label: "Llama 3.2 90B Vision",
    free: true,
  },
  {
    providerId: "openrouter",
    modelId: "meta-llama/llama-3.2-90b-vision-instruct:free",
    label: "Llama 3.2 90B Vision (free)",
    free: true,
  },
  { providerId: "minimax", modelId: "MiniMax-M3", label: "MiniMax M3", free: false },
  { providerId: "wafer", modelId: "MiniMax-M3", label: "MiniMax M3 via Wafer", free: false },
  { providerId: "zai", modelId: "glm-5.2-v", label: "GLM 5.2 V", free: false },
  { providerId: "moonshot", modelId: "kimi-k2.6", label: "Kimi K2.6", free: false },
  { providerId: "anthropic", modelId: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", free: false },
];

export class VisionRequiredError extends Error {
  readonly code = "VISION_REQUIRED";
  readonly modelId: string;
  readonly providerId: string;
  readonly toolName: string;

  constructor(modelId: string, providerId: string, toolName: string) {
    super(
      `The tool "${toolName}" needs a model that can see images, but "${modelId}" ` +
        `(${providerId}) only accepts text. Switch to a vision-capable model — ` +
        `for example ${VISION_FALLBACK_SUGGESTIONS.slice(0, 3)
          .map((s) => s.label)
          .join(", ")} — and run this again.`,
    );
    this.name = "VisionRequiredError";
    this.modelId = modelId;
    this.providerId = providerId;
    this.toolName = toolName;
  }
}
