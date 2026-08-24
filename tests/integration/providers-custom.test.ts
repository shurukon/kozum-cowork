/**
 * Tests for custom provider registration and Cloudflare accountId interpolation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { PROVIDER_PRESETS, getPreset, resolveBaseUrl } from "../../src/main/providers/presets.ts";
import { ProviderRegistry } from "../../src/main/providers/registry.ts";

/* ================================================================ cloudflare == */

describe("resolveBaseUrl — Cloudflare accountId interpolation", () => {
  it("interpolates accountId into the Cloudflare base URL", () => {
    const preset = getPreset("cloudflare-workers-ai");
    assert.ok(preset, "cloudflare-workers-ai preset must exist");
    const url = resolveBaseUrl(preset!, { accountId: "abc123" });
    assert.ok(url.includes("abc123"), `accountId should be in URL, got: ${url}`);
    assert.ok(!url.includes("{accountId}"), "placeholder should be replaced");
  });

  it("leaves an empty string when accountId is absent", () => {
    const preset = getPreset("cloudflare-workers-ai");
    assert.ok(preset);
    const url = resolveBaseUrl(preset!, {});
    assert.ok(!url.includes("{accountId}"), "placeholder should be replaced even when value is empty");
  });

  it("Cloudflare preset has requiresAccountId:true", () => {
    const preset = getPreset("cloudflare-workers-ai");
    assert.ok(preset?.requiresAccountId, "Cloudflare preset should require accountId");
  });
});

/* ================================================================ built-in presets == */

describe("PROVIDER_PRESETS — built-in catalogue", () => {
  it("all built-in presets have builtIn:true", () => {
    for (const p of PROVIDER_PRESETS) {
      assert.equal(p.builtIn, true, `${p.id} should have builtIn:true`);
    }
  });

  it("getPreset returns undefined for unknown ids", () => {
    assert.equal(getPreset("nonexistent-provider-xyz"), undefined);
  });

  it("getPreset returns the correct preset by id", () => {
    const anthropic = getPreset("anthropic");
    assert.ok(anthropic);
    assert.equal(anthropic.name, "Anthropic");
    assert.equal(anthropic.protocol, "anthropic-messages");
  });
});

/* ================================================================ AgentRouter routing == */

describe("AgentRouter protocol routing", () => {
  const router = getPreset("agentrouter")!;
  const registry = new ProviderRegistry({} as never, {} as never);

  it("routes Claude model IDs to Anthropic Messages", () => {
    assert.equal(registry.protocolForModel(router, "claude-opus-4-8"), "anthropic-messages");
    assert.equal(registry.protocolForModel(router, "anthropic/Claude-Opus-4-8"), "anthropic-messages");
    assert.equal(resolveBaseUrl(router, {}, "anthropic-messages"), "https://co.agentrouter.org");
  });

  it("routes OpenAI-family model IDs to OpenAI Chat on /v1", () => {
    assert.equal(registry.protocolForModel(router, "gpt-5.5"), "openai-chat");
    assert.equal(registry.protocolForModel(router, "openai/gpt-5.5"), "openai-chat");
    assert.equal(resolveBaseUrl(router, {}, "openai-chat"), "https://co.agentrouter.org/v1");
  });

  it("does not silently route an unknown model to Anthropic", () => {
    assert.equal(registry.protocolForModel(router, "unknown-model"), "openai-chat");
  });

  it("hits the official protocol paths and auth headers over real HTTP", async () => {
    const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
    const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        requests.push({ url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (req.url === "/messages") {
          res.end(
            sse({ type: "message_start", message: { usage: { input_tokens: 1 } } }) +
            sse({ type: "content_block_start", index: 0, content_block: { type: "text" } }) +
            sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "claude" } }) +
            sse({ type: "content_block_stop", index: 0 }) +
            sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) +
            sse({ type: "message_stop" }),
          );
          return;
        }
        res.end(
          sse({ choices: [{ delta: { content: "gpt" } }] }) +
          sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const message = { id: "m1", role: "user" as const, content: [{ type: "text" as const, text: "hello" }], createdAt: Date.now() };
    const request = (model: string, signal: AbortSignal) => ({
      model,
      system: "test",
      messages: [message],
      tools: [],
      maxTokens: 64,
      temperature: 0,
      signal,
    });

    try {
      const claudeAdapter = registry.adapterForModel(router, "claude-opus-4-8");
      const claudeDeltas = [];
      for await (const delta of claudeAdapter.stream({ providerId: "agentrouter", baseUrl: base, apiKey: "claude-key", meta: {}, extraHeaders: {} }, request("claude-opus-4-8", new AbortController().signal))) {
        claudeDeltas.push(delta);
      }
      assert.equal(claudeAdapter.protocol, "anthropic-messages");
      assert.equal(requests[0]?.url, "/messages");
      assert.equal(requests[0]?.headers["x-api-key"], "claude-key");
      assert.equal(requests[0]?.headers.authorization, undefined);
      assert.ok(claudeDeltas.some((delta) => delta.type === "text" && delta.text === "claude"));

      const gptAdapter = registry.adapterForModel(router, "gpt-5.5");
      const gptDeltas = [];
      for await (const delta of gptAdapter.stream({ providerId: "agentrouter", baseUrl: `${base}/v1`, apiKey: "gpt-key", meta: {}, extraHeaders: {} }, request("gpt-5.5", new AbortController().signal))) {
        gptDeltas.push(delta);
      }
      assert.equal(gptAdapter.protocol, "openai-chat");
      assert.equal(requests[1]?.url, "/v1/chat/completions");
      assert.equal(requests[1]?.headers.authorization, "Bearer gpt-key");
      assert.equal(requests[1]?.headers["x-api-key"], undefined);
      assert.ok(gptDeltas.some((delta) => delta.type === "text" && delta.text === "gpt"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ================================================================ resolveBaseUrl == */

describe("resolveBaseUrl — other providers", () => {
  it("leaves URLs without placeholders unchanged", () => {
    const anthropic = getPreset("anthropic")!;
    const url = resolveBaseUrl(anthropic, {});
    assert.equal(url, "https://api.anthropic.com/v1");
  });

  it("strips trailing slashes", () => {
    const preset = getPreset("anthropic")!;
    // Simulate a URL with trailing slash
    const modified = { ...preset, baseUrl: preset.baseUrl + "/" };
    const url = resolveBaseUrl(modified, {});
    assert.ok(!url.endsWith("/"), `URL should not end with slash: ${url}`);
  });

  it("interpolates Vertex region and projectId", () => {
    const vertex = getPreset("vertex")!;
    const url = resolveBaseUrl(vertex, { region: "us-east1", projectId: "my-project" });
    assert.ok(url.includes("us-east1"), `region should be in URL: ${url}`);
    assert.ok(!url.includes("{region}"), "region placeholder should be replaced");
  });
});
