import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ModeSettings, ToolDefinition } from "../../src/shared/types.ts";
import { makeExecutor } from "../../src/main/tools/index.ts";
import { ToolRegistry, type ToolContext } from "../../src/main/tools/registry.ts";

const definition = (name: string): ToolDefinition => ({
  name,
  title: name,
  description: `test ${name}`,
  inputSchema: { type: "object", properties: {}, required: [] },
  icon: "wrench",
  group: "system",
  modes: ["cowork"],
});

const context = (): Omit<ToolContext, "signal" | "onProgress"> => ({
  sessionId: "allowlist-test",
  mode: "cowork",
  workingFolder: null,
  outputsDir: process.cwd(),
  capabilities: { vision: "yes", tools: true, streaming: true, reasoning: false },
  modelId: "test-model",
  providerId: "test-provider",
});

const settings = (enabledToolNames: string[] | null): ModeSettings => ({
  selection: { providerId: "", keyId: null, modelId: "" },
  systemPromptOverride: null,
  maxTokens: 1024,
  temperature: 0,
  maxIterations: 2,
  permissionMode: "bypass_permissions",
  enabledToolNames,
});

describe("tool allowlist enforcement", () => {
  it("filters advertised tools and blocks a forced disallowed execution", async () => {
    const registry = new ToolRegistry();
    let allowedRuns = 0;
    let blockedRuns = 0;

    registry.register({
      definition: definition("allowed_tool"),
      handler: async () => {
        allowedRuns += 1;
        return { ok: true, content: "allowed" };
      },
    });
    registry.register({
      definition: definition("blocked_tool"),
      handler: async () => {
        blockedRuns += 1;
        return { ok: true, content: "should not run" };
      },
    });

    const executor = makeExecutor(registry, context, () => settings(["allowed_tool"]));
    assert.deepEqual(executor.list("cowork").map((tool) => tool.name), ["allowed_tool"]);

    const result = await executor.execute("blocked_tool", {}, {
      sessionId: "allowlist-test",
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /disabled for cowork mode/i);
    assert.equal(blockedRuns, 0);

    const allowed = await executor.execute("allowed_tool", {}, {
      sessionId: "allowlist-test",
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowedRuns, 1);
  });

  it("treats null as the explicit all-tools setting", () => {
    const registry = new ToolRegistry();
    registry.register({ definition: definition("one"), handler: async () => ({ ok: true, content: "1" }) });
    registry.register({ definition: definition("two"), handler: async () => ({ ok: true, content: "2" }) });

    const executor = makeExecutor(registry, context, () => settings(null));
    assert.deepEqual(executor.list("cowork").map((tool) => tool.name), ["one", "two"]);
  });
});
