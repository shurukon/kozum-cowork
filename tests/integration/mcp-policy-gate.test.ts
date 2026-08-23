/**
 * Integration tests for the MCP per-tool policy gate (Task 6).
 *
 * Newly added servers default to {default:"ask"}; mcp_call evaluates the
 * effective policy for `mcp__<server>__<tool>` BEFORE calling the tool:
 *   deny → structured failure ("blocked by user"),
 *   ask  → AskBroker flow identical to ask_user_question, with
 *          Allow once / Always this session / Deny,
 *   allow → proceeds.
 * Unknown servers skip the gate and fail with the familiar contract error.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpManager } from "../../src/main/mcp/manager.ts";
import { makeMcpTools } from "../../src/main/tools/mcp.ts";
import { AskBroker } from "../../src/main/tools/ask.ts";
import type { Tool, ToolContext } from "../../src/main/tools/registry.ts";
import type { McpServerConfig } from "../../src/shared/types.ts";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s1",
    mode: "cowork",
    workingFolder: null,
    outputsDir: "/tmp",
    capabilities: { vision: "no", tools: true, streaming: false, reasoning: false },
    modelId: "test",
    providerId: "test",
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...overrides,
  };
}

function makeConfig(id: string): McpServerConfig {
  return {
    id,
    name: id,
    enabled: true,
    transport: "http",
    url: "http://127.0.0.1:9/unreachable",
    hasAuthToken: false,
    createdAt: Date.now(),
    installedByAgent: false,
    status: "disconnected",
    toolCount: 0,
    allowLocal: false,
  };
}

async function callTool(tool: Tool, ctx: ToolContext): Promise<{ ok: boolean; error?: string }> {
  const result = await tool.handler({ serverId: "srv", tool: "echo", args: {} }, ctx);
  return { ok: result.ok, error: result.error };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout waiting for prompt"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("MCP per-tool policy gate", () => {
  it("defaults newly added servers to ask-for-every-tool", async () => {
    const manager = new McpManager();
    await manager.add(makeConfig("srv"));
    const status = manager.status().find((s) => s.id === "srv");
    assert.equal(status?.toolPolicy?.default, "ask");
  });

  it("deny fails with 'blocked by user' before any call is attempted", async () => {
    const manager = new McpManager();
    await manager.add(makeConfig("srv"));
    await manager.setToolPolicy("srv", { default: "ask", tools: { echo: "deny" } });

    let questions = 0;
    const broker = new AskBroker();
    const tools = makeMcpTools(manager, broker);
    const call = tools.find((t) => t.definition.name === "mcp_call")!;

    const result = await call.handler(
      { serverId: "srv", tool: "echo", args: {} },
      makeCtx({ onQuestion: () => { questions += 1; } }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /blocked by user/i);
    assert.equal(questions, 0, "deny must not prompt");
  });

  it("allow proceeds straight through without prompting", async () => {
    const manager = new McpManager();
    await manager.add(makeConfig("srv"));
    await manager.setToolPolicy("srv", { default: "ask", tools: { echo: "allow" } });

    let questions = 0;
    const broker = new AskBroker();
    const tools = makeMcpTools(manager, broker);
    const call = tools.find((t) => t.definition.name === "mcp_call")!;

    // The server is not connected on purpose: reaching the *connection* error
    // proves the policy gate opened and handed control to the transport.
    const result = await call.handler(
      { serverId: "srv", tool: "echo", args: {} },
      makeCtx({ onQuestion: () => { questions += 1; } }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not connected/i);
    assert.doesNotMatch(result.error ?? "", /blocked by user|policy/i);
    assert.equal(questions, 0);
  });

  it("asks via AskBroker and resumes after the user allows once", async () => {
    const manager = new McpManager();
    await manager.add(makeConfig("srv"));

    const captured: Array<{ requestId: string; options: Array<{ label: string; value: string }> }> = [];
    const broker = new AskBroker();
    const tools = makeMcpTools(manager, broker);
    const call = tools.find((t) => t.definition.name === "mcp_call")!;
    const ctx = makeCtx({
      onQuestion: (payload) => captured.push({ requestId: payload.requestId, options: payload.options }),
    });

    const pending = callTool(call, ctx);
    await waitFor(() => captured.length === 1);

    // The prompt mirrors the permission-style option rows.
    assert.deepEqual(
      captured[0]!.options.map((o) => o.value),
      ["allow_once", "allow_always", "deny"],
    );

    broker.resolve(captured[0]!.requestId, ["allow_once"], "s1");
    const result = await pending;
    assert.match(result.error ?? "", /not connected/i, "gate must open after allow");
    assert.doesNotMatch(result.error ?? "", /blocked by user|policy/i);
  });

  it("'Always allow this session' suppresses subsequent prompts", async () => {
    const manager = new McpManager();
    await manager.add(makeConfig("srv"));

    let questions = 0;
    let lastRequestId = "";
    const broker = new AskBroker();
    const tools = makeMcpTools(manager, broker);
    const call = tools.find((t) => t.definition.name === "mcp_call")!;
    const ctx = makeCtx({
      onQuestion: (payload) => { questions += 1; lastRequestId = payload.requestId; },
    });

    const first = callTool(call, ctx);
    await waitFor(() => questions === 1);
    broker.resolve(lastRequestId, ["allow_always"], "s1");
    await first;

    // Second invocation in the same session: no new question.
    const second = await callTool(call, ctx);
    assert.match(second.error ?? "", /not connected/i);
    assert.equal(questions, 1, "session-scoped always-allow must not re-prompt");
  });

  it("aborting while a policy prompt is pending denies cleanly", async () => {
    const manager = new McpManager();
    await manager.add(makeConfig("srv"));

    // A fresh session id: earlier tests earned a session-scoped allow for
    // s1, and that cache is intentionally honored across tests sharing it.
    const controller = new AbortController();
    const broker = new AskBroker();
    const tools = makeMcpTools(manager, broker);
    const call = tools.find((t) => t.definition.name === "mcp_call")!;
    const ctx = makeCtx({ sessionId: "s-abort", signal: controller.signal });

    const pending = callTool(call, ctx);
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /blocked by user|denied|policy/i);
  });

  it("unknown servers skip the gate entirely (no phantom prompts)", async () => {
    const manager = new McpManager();
    let questions = 0;
    const broker = new AskBroker();
    const tools = makeMcpTools(manager, broker);
    const call = tools.find((t) => t.definition.name === "mcp_call")!;

    const result = await call.handler(
      { serverId: "missing-server", tool: "missing-tool", args: {} },
      makeCtx({ sessionId: "s2", onQuestion: () => { questions += 1; } }),
    );
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error ?? "", /blocked by user|policy/i);
    assert.equal(questions, 0);
  });
});
