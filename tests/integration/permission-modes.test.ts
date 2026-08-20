/**
 * Integration tests for the real permission gate.
 *
 * accept_all   — mutating tools run without asking.
 * accept_edits — filesystem edits run; shell/process/computer ask.
 * ask          — every mutating tool asks.
 * reject       — every mutating tool is blocked.
 *
 * The callback represents the live SessionManager permission broker boundary;
 * the test does not execute a fake tool handler or bypass the gate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPermission, blockedResult } from "../../src/main/tools/permissions.ts";
import type { PermissionMode } from "../../src/shared/types.ts";

type Answer = "yes" | "allow" | "approve" | "y" | "no" | "deny" | "reject" | "n" | "cancel";

function makeOpts(
  toolName: string,
  toolGroup: string,
  permissionMode: PermissionMode,
  answer: Answer = "yes",
) {
  return {
    toolName,
    toolGroup,
    permissionMode,
    sessionId: "test-session",
    requestPermission: async (_requestId: string, _reason: string): Promise<string[]> => [answer],
  };
}

describe("accept_all — nothing blocks or asks", () => {
  it("allows shell, filesystem and computer tools without asking", async () => {
    let asked = 0;
    for (const [toolName, toolGroup] of [
      ["shell_exec", "shell"],
      ["file_write", "filesystem"],
      ["computer_click", "computer"],
    ]) {
      const decision = await checkPermission({
        ...makeOpts(toolName, toolGroup, "accept_all"),
        requestPermission: async () => { asked += 1; return ["no"]; },
      });
      assert.equal(decision.allowed, true);
    }
    assert.equal(asked, 0);
  });
});

describe("reject — mutating tools are blocked", () => {
  it("blocks shell, filesystem and computer tools without asking", async () => {
    let asked = 0;
    for (const [toolName, toolGroup] of [
      ["shell_exec", "shell"],
      ["file_write", "filesystem"],
      ["computer_type", "computer"],
    ]) {
      const decision = await checkPermission({
        ...makeOpts(toolName, toolGroup, "reject"),
        requestPermission: async () => { asked += 1; return ["yes"]; },
      });
      assert.equal(decision.allowed, false);
      assert.match(decision.blockedMessage ?? "", /reject/i);
    }
    assert.equal(asked, 0);
  });

  it("still allows read-only tools and web tools", async () => {
    for (const [toolName, toolGroup] of [["file_read", "filesystem"], ["web_fetch", "web"]]) {
      const decision = await checkPermission(makeOpts(toolName, toolGroup, "reject"));
      assert.equal(decision.allowed, true);
    }
  });
});

describe("accept_edits — file edits auto-approve; host actions ask", () => {
  it("allows filesystem writes without asking", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("file_write", "filesystem", "accept_edits"),
      requestPermission: async () => { asked = true; return ["no"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, false);
  });

  it("asks for shell and allows on yes", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("shell_exec", "shell", "accept_edits"),
      requestPermission: async () => { asked = true; return ["yes"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, true);
  });

  it("blocks shell when the user denies", async () => {
    const decision = await checkPermission(makeOpts("shell_exec", "shell", "accept_edits", "no"));
    assert.equal(decision.allowed, false);
  });

  it("allows read-only filesystem tools without asking", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("file_read", "filesystem", "accept_edits"),
      requestPermission: async () => { asked = true; return ["yes"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, false);
  });
});

describe("ask — every mutating tool asks", () => {
  it("asks for file writes and allows on yes", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("file_write", "filesystem", "ask"),
      requestPermission: async () => { asked = true; return ["yes"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, true);
  });

  it("asks for shell and blocks on no", async () => {
    const decision = await checkPermission(makeOpts("shell_exec", "shell", "ask", "no"));
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockedMessage);
  });

  it("does not ask for read-only tools", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("file_search", "filesystem", "ask"),
      requestPermission: async () => { asked = true; return ["yes"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, false);
  });
});

describe("permission answer normalisation", () => {
  for (const answer of ["yes", "allow", "approve", "y"] as const) {
    it(`treats ${answer} as approval`, async () => {
      const decision = await checkPermission(makeOpts("shell_exec", "shell", "ask", answer));
      assert.equal(decision.allowed, true);
    });
  }
  for (const answer of ["no", "deny", "reject", "n", "cancel"] as const) {
    it(`treats ${answer} as denial`, async () => {
      const decision = await checkPermission(makeOpts("shell_exec", "shell", "ask", answer));
      assert.equal(decision.allowed, false);
    });
  }
});

describe("blockedResult helper", () => {
  it("returns a ToolResult with ok:false and a visible error", () => {
    const result = blockedResult("Permission denied.");
    assert.equal(result.ok, false);
    assert.equal(result.error, "Permission denied.");
    assert.equal(result.content, "Permission denied.");
  });
});


describe("side-effect classification beyond files and shell", () => {
  it("keeps read-only browser, MCP, plugin and task inspection available", async () => {
    for (const [toolName, toolGroup] of [
      ["browser_get_content", "browser"],
      ["browser_back", "browser"],
      ["mcp_list", "mcp"],
      ["plugin_list", "plugin"],
      ["task_update", "task"],
      ["web_search", "web"],
      ["ask_user_question", "agent"],
    ]) {
      const decision = await checkPermission(makeOpts(toolName, toolGroup, "reject"));
      assert.equal(decision.allowed, true, `${toolName} should remain available`);
    }
  });

  it("blocks persistent memory, schedule, connector and browser actions in reject", async () => {
    for (const [toolName, toolGroup] of [
      ["memory_write", "system"],
      ["schedule_create", "task"],
      ["mcp_install", "mcp"],
      ["plugin_install", "plugin"],
      ["browser_click", "browser"],
    ]) {
      const decision = await checkPermission(makeOpts(toolName, toolGroup, "reject"));
      assert.equal(decision.allowed, false, `${toolName} should be blocked`);
    }
  });

  it("asks before a connector action in ask mode and proceeds only after approval", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("mcp_call", "mcp", "ask"),
      requestPermission: async () => { asked = true; return ["allow"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, true);
  });

  it("does not auto-approve schedule or host actions in accept_edits", async () => {
    let asked = 0;
    for (const [toolName, toolGroup] of [["schedule_run_now", "task"], ["browser_type", "browser"]]) {
      const decision = await checkPermission({
        ...makeOpts(toolName, toolGroup, "accept_edits"),
        requestPermission: async () => { asked += 1; return ["no"]; },
      });
      assert.equal(decision.allowed, false);
    }
    assert.equal(asked, 2);
  });
});
