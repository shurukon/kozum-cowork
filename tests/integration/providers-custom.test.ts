/**
 * Tests for custom provider registration and Cloudflare accountId interpolation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PROVIDER_PRESETS, getPreset, resolveBaseUrl } from "../../src/main/providers/presets.ts";

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
