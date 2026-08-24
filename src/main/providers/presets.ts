/**
 * Kozum Cowork — shipped provider presets.
 *
 * Every base URL here was verified against vendor documentation. Where a
 * vendor could not be fully verified the preset says so plainly in `notes`
 * rather than pretending the endpoint is known-good.
 *
 * Adding a vendor is a data change, not a code change, unless it speaks a wire
 * protocol we do not already have an adapter for.
 */

import type { ProviderPreset } from "../../shared/types.ts";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  /* ------------------------------------------------------- first-party -- */
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    authScheme: "x-api-key",
    modelsPath: "/models",
    defaultHeaders: { "anthropic-version": "2023-06-01" },
    staticModels: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
    docsUrl: "https://docs.anthropic.com/en/api/messages",
    notes:
      "Native Messages API. Auth rides in x-api-key, not Authorization — a common integration mistake.",
    builtIn: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    builtIn: true,
  },

  /* ------------------------------------------------------------ free --- */
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    protocol: "openai-chat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    docsUrl: "https://build.nvidia.com/models",
    notes:
      "Free tier, no card required — get a key at build.nvidia.com. Trial terms allow logging, so avoid confidential data. Hosts vision models (nemotron-nano-2-vl, llama-3.2-90b-vision) alongside minimax and kimi.",
    builtIn: true,
  },
  {
    id: "cerebras",
    name: "Cerebras",
    protocol: "openai-chat",
    baseUrl: "https://api.cerebras.ai/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    docsUrl: "https://inference-docs.cerebras.ai",
    notes:
      "Free tier available; extremely high throughput. No vision models in the catalogue — computer use and screenshot reasoning are unavailable here.",
    builtIn: true,
  },
  {
    id: "google-ai-studio",
    name: "Google AI Studio (Gemini)",
    protocol: "gemini-generative",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authScheme: "query-key",
    modelsPath: "/models",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    notes:
      "Free tier. Native protocol used here rather than the OpenAI-compat shim, because the native API exposes system instructions and inline image parts more faithfully. Every Gemini model is multimodal.",
    builtIn: true,
  },
  {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    protocol: "openai-chat",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1",
    authScheme: "bearer",
    modelsPath: null,
    requiresAccountId: true,
    staticModels: [
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      "@cf/meta/llama-4-maverick-17b-128e-instruct",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/qwen/qwen2.5-coder-32b-instruct",
    ],
    docsUrl: "https://developers.cloudflare.com/workers-ai/",
    notes:
      "Needs your Cloudflare account ID in the URL and an API token with Workers AI permission. No catalogue endpoint — the model list is curated.",
    builtIn: true,
  },

  /* --------------------------------------------------------- gateways -- */
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    defaultHeaders: {
      "HTTP-Referer": "https://kozum.app",
      "X-Title": "Kozum Cowork",
    },
    docsUrl: "https://openrouter.ai/docs",
    notes:
      "Widest catalogue. Models suffixed :free cost nothing. Capability flags come straight from the catalogue, so vision detection here is exact rather than inferred.",
    builtIn: true,
  },
  {
    id: "kilo",
    name: "Kilo Gateway",
    protocol: "openai-chat",
    baseUrl: "https://api.kilo.ai/api/gateway",
    authScheme: "bearer",
    modelsPath: "/models",
    staticModels: ["kilo-auto/frontier", "kilo-auto/free"],
    docsUrl: "https://kilocode.ai/docs",
    notes:
      "Note the non-standard /api/gateway prefix — there is no /v1. Catalogue re-verified live on 2026-08-23 (GET /models needs no auth and returns an OpenRouter-shaped {data:[…]} list led by kilo-auto/* ids).",
    builtIn: true,
  },
  {
    id: "wafer",
    name: "Wafer",
    protocol: "openai-chat",
    baseUrl: "https://pass.wafer.ai/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    staticModels: ["GLM-5.2", "Kimi-K3", "Kimi-K2.6", "Qwen3.5-397B-A17B", "DeepSeek-V4-Flash-0731-Fast"],
    docsUrl: "https://wafer.ai",
    notes:
      "Verified live 2026-08-23 — GET /v1/models returns an OpenAI-shaped catalogue (GLM, Kimi, Qwen, DeepSeek). Keys are prefixed wfr_. Send Wafer-ZDR: required for zero data retention; Kimi-K2.6 rejects ZDR requests.",
    builtIn: true,
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    // Default wire protocol: most of Zen's catalogue (GLM, Kimi, DeepSeek,
    // MiniMax and every free model) speaks OpenAI Chat Completions.
    protocol: "openai-chat",
    baseUrl: "https://opencode.ai/zen/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    staticModels: [
      "big-pickle",
      "x-preview-f-free",
      "minimax-m3",
      "glm-5.2",
      "kimi-k2.7-code",
      "deepseek-v4-flash",
      "gpt-5.6-luna",
      "claude-haiku-4-5",
    ],
    docsUrl: "https://opencode.ai/docs/zen",
    // Verified against https://opencode.ai/docs/zen/ on 2026-08-23.
    // One base URL, three documented endpoints — adapters append their own
    // path segment (/chat/completions, /responses, /messages), so routing is
    // purely adapter selection by model-id prefix.
    protocolRoutes: {
      "openai-responses": ["gpt-", "grok-", "muse-spark"],
      "anthropic-messages": ["claude-", "qwen3"],
    },
    notes:
      "Verified 2026-08-23 against vendor docs. Split protocol under one base URL: GPT/Grok/Muse models use Responses (/responses), Claude/Qwen ids use Anthropic Messages (/messages), GLM/Kimi/DeepSeek/MiniMax/free ids use Chat Completions (/chat/completions). Gemini ids are exposed only via Google-shaped routes and are not selectable here. Live catalogue at /models.",
    builtIn: true,
  },
  {
    id: "agentrouter",
    name: "AgentRouter",
    // AgentRouter exposes both documented wire protocols under one account.
    // OpenAI-compatible is the default; Claude model ids are routed to the
    // Anthropic Messages endpoint below rather than being sent to /v1/chat.
    protocol: "openai-chat",
    baseUrl: "https://co.agentrouter.org/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    staticModels: ["claude-opus-4-8", "gpt-5.5", "glm-5.1", "kimi-k2.6"],
    protocolRoutes: {
      "anthropic-messages": ["claude-"],
      "openai-chat": ["gpt-", "kimi-", "glm-", "deepseek-", "minimax-", "qwen-"],
    },
    protocolBaseUrls: {
      "anthropic-messages": "https://co.agentrouter.org",
      "openai-chat": "https://co.agentrouter.org/v1",
    },
    docsUrl: "https://co.agentrouter.org/portal/guide",
    notes:
      "Catalogue verified live on 2026-08-23; routing re-verified against AgentRouter's official guide on 2026-08-24. OpenAI-compatible models use https://co.agentrouter.org/v1; Claude models use Anthropic Messages at https://co.agentrouter.org without /v1. Kilo Code identifies this provider as agentrouter.",
    builtIn: true,
  },

  /* ----------------------------------------------------------- direct -- */
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    authScheme: "bearer",
    modelsPath: "/models",
    docsUrl: "https://api-docs.deepseek.com",
    notes:
      "Base URL has no /v1 segment. Text-only catalogue — no vision, so computer use is unavailable here.",
    builtIn: true,
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    docsUrl: "https://platform.moonshot.cn/docs",
    notes: "kimi-k2.6 and later accept image input.",
    builtIn: true,
  },
  {
    id: "minimax",
    name: "MiniMax",
    protocol: "openai-chat",
    baseUrl: "https://api.minimaxi.chat/v1",
    authScheme: "bearer",
    modelsPath: "/models",
    staticModels: ["MiniMax-M3", "MiniMax-M2"],
    docsUrl: "https://platform.minimax.io/docs",
    notes:
      "Host liveness verified 2026-08-23 (GET /v1/models answers 401 Unauthorized without a key, i.e. a live OpenAI-style endpoint). International host is api.minimaxi.chat (platform.minimax.io is the console, not the API). MiniMax-M3 is natively multimodal with a 1M context — a good default for computer use.",
    builtIn: true,
  },
  {
    id: "zai",
    name: "Z.AI (GLM)",
    protocol: "openai-chat",
    baseUrl: "https://api.z.ai/api/paas/v4",
    authScheme: "bearer",
    modelsPath: "/models",
    staticModels: ["glm-5.2", "glm-5.2-v", "glm-4.6", "glm-4v-plus"],
    docsUrl: "https://docs.z.ai",
    notes:
      "Non-standard /api/paas/v4 prefix. China endpoint is open.bigmodel.cn. Only the -v variants accept images; plain GLM ids are text-only.",
    builtIn: true,
  },

  /* --------------------------------------------------------- special --- */
  {
    id: "vertex",
    name: "Google Vertex AI",
    protocol: "vertex-gemini",
    baseUrl: "https://{region}-aiplatform.googleapis.com/v1",
    authScheme: "google-adc",
    modelsPath: null,
    requiresProjectId: true,
    requiresRegion: true,
    staticModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-pro"],
    docsUrl: "https://cloud.google.com/vertex-ai/docs",
    notes:
      "No static API keys. Requires a service-account JSON; Kozum exchanges it for a short-lived OAuth token and refreshes before the ~1h expiry.",
    builtIn: true,
  },
  {
    id: "chatgpt-oauth",
    name: "ChatGPT Subscription",
    protocol: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authScheme: "bearer",
    modelsPath: null,
    staticModels: ["gpt-5.2", "gpt-5.2-codex", "gpt-5.1-codex"],
    docsUrl: "https://developers.openai.com/codex/",
    notes:
      "Signs in with the same OAuth device flow the official Codex CLI uses — not a reverse-engineered API, but it is scoped to personal use and rate-limited by your Plus/Pro tier. There is no other supported way to drive a ChatGPT subscription programmatically.",
    builtIn: true,
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    protocol: "openai-chat",
    baseUrl: "",
    authScheme: "bearer",
    modelsPath: "/models",
    notes:
      "Escape hatch for anything not listed: local llama.cpp or vLLM servers, corporate gateways, LiteLLM, or a vendor added after this build.",
    builtIn: true,
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/**
 * Interpolate the {accountId} / {region} placeholders some vendors need.
 * Returns the URL unchanged when a preset carries no placeholders.
 */
export function resolveBaseUrl(
  preset: ProviderPreset,
  meta: Record<string, string> | undefined,
  protocol: ProviderPreset["protocol"] = preset.protocol,
): string {
  let url = preset.protocolBaseUrls?.[protocol] ?? preset.baseUrl;
  if (preset.requiresAccountId) {
    url = url.replace("{accountId}", meta?.accountId ?? "");
  }
  if (preset.requiresRegion) {
    url = url.replace("{region}", meta?.region ?? "us-central1");
  }
  if (preset.requiresProjectId) {
    url = url.replace("{projectId}", meta?.projectId ?? "");
  }
  return url.replace(/\/+$/, "");
}
