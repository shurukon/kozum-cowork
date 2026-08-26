/**
 * Preset audit snapshot test (Task 10).
 *
 * Every shipped provider preset must be structurally complete:
 * - a non-empty baseUrl (the legacy "custom" escape hatch was removed on
 *   2026-08-25; user-defined providers live in settings.customProviders),
 * - a known wire protocol,
 * - at least one model source: a live modelsPath OR ≥1 staticModels entry.
 *
 * Split-protocol presets must additionally declare routes that cover their
 * own static models, so no curated id silently falls to the wrong adapter.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS } from "../../src/main/providers/presets.ts";
import type { ProviderProtocol } from "../../src/shared/types.ts";

const KNOWN_PROTOCOLS: ProviderProtocol[] = [
  "anthropic-messages",
  "openai-chat",
  "openai-responses",
  "gemini-generative",
  "vertex-gemini",
];

describe("provider presets audit", () => {
  it("every preset has a baseUrl, protocol and ≥1 model source", () => {
    for (const preset of PROVIDER_PRESETS) {
      assert.ok(
        preset.id !== "custom",
        'the legacy "Custom (OpenAI-compatible)" escape hatch must stay removed',
      );
      assert.ok(preset.baseUrl.length > 0, `${preset.id}: missing baseUrl`);
      assert.ok(
        KNOWN_PROTOCOLS.includes(preset.protocol),
        `${preset.id}: unknown protocol ${preset.protocol}`,
      );
      const hasCatalogue = preset.modelsPath !== null && preset.modelsPath !== undefined;
      const hasStatic = (preset.staticModels?.length ?? 0) > 0;
      assert.ok(
        hasCatalogue || hasStatic,
        `${preset.id}: needs modelsPath or staticModels so its dropdown is never empty`,
      );
    }
  });

  it("opencode-zen routes cover every documented protocol family", () => {
    const zen = PROVIDER_PRESETS.find((p) => p.id === "opencode-zen");
    assert.ok(zen);
    // Verified 2026-08-23 against https://opencode.ai/docs/zen/:
    // GPT/Grok/Muse → Responses; Claude/Qwen → Anthropic Messages;
    // GLM/Kimi/DeepSeek/MiniMax/free → Chat Completions (default).
    assert.deepEqual(
      zen!.protocolRoutes,
      {
        "openai-responses": ["gpt-", "grok-", "muse-spark"],
        "anthropic-messages": ["claude-", "qwen3"],
      },
    );
    assert.equal(zen!.protocol, "openai-chat");
    assert.equal(zen!.modelsPath, "/models", "Zen exposes a live catalogue at /models");
    assert.ok((zen!.staticModels?.length ?? 0) > 0);
  });

  it("no zen static model is misrouted by an overlapping prefix", () => {
    const zen = PROVIDER_PRESETS.find((p) => p.id === "opencode-zen")!;
    const routes = zen.protocolRoutes ?? {};
    const resolve = (modelId: string): string => {
      for (const [protocol, prefixes] of Object.entries(routes)) {
        if (prefixes?.some((p) => modelId === p || modelId.startsWith(p))) return protocol;
      }
      return zen.protocol;
    };
    for (const model of zen.staticModels ?? []) {
      const routed = resolve(model);
      const expectsResponses = /^(gpt-|grok-|muse-spark)/.test(model);
      const expectsAnthropic = /^(claude-|qwen3)/.test(model);
      if (expectsResponses) assert.equal(routed, "openai-responses", `${model} must use Responses`);
      else if (expectsAnthropic) assert.equal(routed, "anthropic-messages", `${model} must use Messages`);
      else assert.equal(routed, "openai-chat", `${model} must default to Chat Completions`);
    }
  });

  it("previously broken endpoints carry verification notes", () => {
    const notes = new Map(PROVIDER_PRESETS.map((p) => [p.id, p.notes ?? ""]));
    assert.match(notes.get("opencode-zen")!, /2026-08-23/);
    assert.doesNotMatch(notes.get("agentrouter")!, /^UNVERIFIED/, "agentrouter host was probed live");
    assert.match(notes.get("agentrouter")!, /2026-08-23/);
    assert.match(notes.get("wafer")!, /2026-08-23/);
    assert.match(notes.get("minimax")!, /2026-08-23/);
    assert.match(notes.get("kilo")!, /2026-08-23/);
  });
});
