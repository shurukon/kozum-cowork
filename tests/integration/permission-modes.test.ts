/**
 * Integration tests for the real permission gate.
 *
 * bypass_permissions   — mutating tools run without asking.
 * accept_edits — filesystem edits run; shell/process/computer ask.
 * ask_permission — every mutating tool asks.
 * plan         — every mutating tool is blocked.
 *
 * The callback represents the live SessionManager permission broker boundary;
 * the test does not execute a fake tool handler or bypass the gate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPermission, blockedResult } from "../../src/main/tools/permissions.ts";
import type { PermissionMode } from "../../src/shared/types.ts";

type Answer = "yes" | "allow" | "approve" | "y" | "no" | "deny" | "reject" | "n" | "cancel" | "allow_once" | "allow_always" | "allow once" | "allow always";

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

describe("bypass_permissions — nothing blocks or asks", () => {
  it("allows shell, filesystem and computer tools without asking", async () => {
    let asked = 0;
    for (const [toolName, toolGroup] of [
      ["shell_exec", "shell"],
      ["file_write", "filesystem"],
      ["computer_click", "computer"],
    ]) {
      const decision = await checkPermission({
        ...makeOpts(toolName, toolGroup, "bypass_permissions"),
        requestPermission: async () => { asked += 1; return ["no"]; },
      });
      assert.equal(decision.allowed, true);
    }
    assert.equal(asked, 0);
  });
});

describe("plan — mutating tools are blocked", () => {
  it("blocks shell, filesystem and computer tools without asking", async () => {
    let asked = 0;
    for (const [toolName, toolGroup] of [
      ["shell_exec", "shell"],
      ["file_write", "filesystem"],
      ["computer_type", "computer"],
    ]) {
      const decision = await checkPermission({
        ...makeOpts(toolName, toolGroup, "plan"),
        requestPermission: async () => { asked += 1; return ["yes"]; },
      });
      assert.equal(decision.allowed, false);
      assert.match(decision.blockedMessage ?? "", /plan/i);
    }
    assert.equal(asked, 0);
  });

  it("still allows read-only tools and web tools", async () => {
    for (const [toolName, toolGroup] of [["file_read", "filesystem"], ["web_fetch", "web"]]) {
      const decision = await checkPermission(makeOpts(toolName, toolGroup, "plan"));
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

  it("still asks before destructive filesystem operations", async () => {
    let asked = 0;
    const decision = await checkPermission({
      ...makeOpts("file_delete", "filesystem", "accept_edits", "deny"),
      requestPermission: async () => { asked += 1; return ["deny"]; },
    });
    assert.equal(decision.allowed, false);
    assert.equal(asked, 1);
  });
});

describe("ask_permission — every mutating tool asks", () => {
  it("asks for file writes and allows on yes", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("file_write", "filesystem", "ask_permission"),
      requestPermission: async () => { asked = true; return ["yes"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, true);
  });

  it("asks for shell and blocks on no", async () => {
    const decision = await checkPermission(makeOpts("shell_exec", "shell", "ask_permission", "no"));
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockedMessage);
  });

  it("does not ask for read-only tools", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("file_search", "filesystem", "ask_permission"),
      requestPermission: async () => { asked = true; return ["yes"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, false);
  });
});

describe("session-scoped permission decisions", () => {
  it("returns allow once without remembering the tool", async () => {
    let remembered = 0;
    const decision = await checkPermission({
      ...makeOpts("shell_exec", "shell", "ask_permission", "allow_once"),
      rememberTool: () => { remembered += 1; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(remembered, 0);
  });

  it("remembers allow always and bypasses the next request in the same session", async () => {
    const allowedTools = new Set<string>();
    let asked = 0;
    const first = await checkPermission({
      ...makeOpts("shell_exec", "shell", "ask_permission", "allow_always"),
      sessionAllowedTools: allowedTools,
      rememberTool: (toolName) => allowedTools.add(toolName),
      requestPermission: async () => { asked += 1; return ["allow_always"]; },
    });
    const second = await checkPermission({
      ...makeOpts("shell_exec", "shell", "ask_permission"),
      sessionAllowedTools: allowedTools,
      rememberTool: (toolName) => allowedTools.add(toolName),
      requestPermission: async () => { asked += 1; return ["deny"]; },
    });
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(asked, 1);
  });
});

describe("permission answer normalisation", () => {
  for (const answer of ["yes", "allow", "approve", "y"] as const) {
    it(`treats ${answer} as approval`, async () => {
      const decision = await checkPermission(makeOpts("shell_exec", "shell", "ask_permission", answer));
      assert.equal(decision.allowed, true);
    });
  }
  for (const answer of ["no", "deny", "reject", "n", "cancel"] as const) {
    it(`treats ${answer} as denial`, async () => {
      const decision = await checkPermission(makeOpts("shell_exec", "shell", "ask_permission", answer));
      assert.equal(decision.allowed, false);
    });
  }
  // The exact strings the renderer's PermissionBanner sends back.
  it("treats the banner's allow_once verbatim as approval", async () => {
    const decision = await checkPermission(makeOpts("shell_exec", "shell", "ask_permission", "allow_once"));
    assert.equal(decision.allowed, true);
  });
  it("treats the banner's allow_always verbatim as approval + remember", async () => {
    let remembered = 0;
    const decision = await checkPermission({
      ...makeOpts("shell_exec", "shell", "ask_permission", "allow_always"),
      rememberTool: () => { remembered += 1; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(remembered, 1);
  });
  it("normalises case and spacing variants", async () => {
    for (const answer of ["ALLOW_ONCE", "Allow Once", "ALLOW_ALWAYS", "Always"]) {
      const decision = await checkPermission(
        makeOpts("shell_exec", "shell", "ask_permission", answer as Answer),
      );
      assert.equal(decision.allowed, true, `"${answer}" should approve`);
    }
  });
  it("treats an unknown answer as denial, never as approval", async () => {
    const decision = await checkPermission(
      makeOpts("shell_exec", "shell", "ask_permission", "banana" as Answer),
    );
    assert.equal(decision.allowed, false);
  });
});

describe("ask_dangerous — Cowork's 'Ask for dangerous actions'", () => {
  it("asks for every tool in DANGEROUS_TOOLS and allows on approval", async () => {
    for (const [toolName, toolGroup] of [
      ["file_delete", "filesystem"],
      ["directory_delete", "filesystem"],
      ["file_move", "filesystem"],
      ["process_kill", "process"],
      ["memory_delete", "system"],
      ["schedule_create", "task"],
      ["schedule_update", "task"],
      ["schedule_delete", "task"],
      ["schedule_run_now", "task"],
    ]) {
      let asked = 0;
      const decision = await checkPermission({
        ...makeOpts(toolName, toolGroup, "ask_dangerous", "yes"),
        requestPermission: async () => { asked += 1; return ["yes"]; },
      });
      assert.equal(decision.allowed, true, `${toolName} should run after approval`);
      assert.equal(asked, 1, `${toolName} must ask exactly once`);
    }
  });

  it("blocks a dangerous tool when the user denies", async () => {
    const decision = await checkPermission(
      makeOpts("directory_delete", "filesystem", "ask_dangerous", "deny"),
    );
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockedMessage);
  });

  it("runs shell, computer, browser, web and file writes silently (dangerous ≠ these)", async () => {
    for (const [toolName, toolGroup] of [
      ["shell_exec", "shell"],
      ["computer_click", "computer"],
      ["browser_navigate", "browser"],
      ["web_fetch", "web"],
      ["web_search", "web"],
      ["file_write", "filesystem"],
      ["memory_write", "system"],
      ["project_kb_build", "system"],
    ]) {
      let asked = 0;
      const decision = await checkPermission({
        ...makeOpts(toolName, toolGroup, "ask_dangerous"),
        requestPermission: async () => { asked += 1; return ["deny"]; },
      });
      assert.equal(decision.allowed, true, `${toolName} should pass without asking`);
      assert.equal(asked, 0, `${toolName} must not prompt in ask_dangerous`);
    }
  });

  it("keeps read-only tools available without asking", async () => {
    for (const [toolName, toolGroup] of [["file_read", "filesystem"], ["browser_get_content", "browser"]]) {
      const decision = await checkPermission(makeOpts(toolName, toolGroup, "ask_dangerous"));
      assert.equal(decision.allowed, true);
    }
  });

  it("honors the session allow-always cache before mode logic", async () => {
    const allowedTools = new Set<string>(["file_delete"]);
    let asked = 0;
    const decision = await checkPermission({
      ...makeOpts("file_delete", "filesystem", "ask_dangerous"),
      sessionAllowedTools: allowedTools,
      rememberTool: (toolName) => allowedTools.add(toolName),
      requestPermission: async () => { asked += 1; return ["deny"]; },
    });
    assert.equal(decision.allowed, true);
    assert.equal(asked, 0, "a session-scoped allow must suppress the prompt");
  });
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
      const decision = await checkPermission(makeOpts(toolName, toolGroup, "plan"));
      assert.equal(decision.allowed, true, `${toolName} should remain available`);
    }
  });

  it("blocks persistent memory, schedule, connector and browser actions in plan", async () => {
    for (const [toolName, toolGroup] of [
      ["memory_write", "system"],
      ["schedule_create", "task"],
      ["mcp_install", "mcp"],
      ["plugin_install", "plugin"],
      ["browser_click", "browser"],
    ]) {
      const decision = await checkPermission(makeOpts(toolName, toolGroup, "plan"));
      assert.equal(decision.allowed, false, `${toolName} should be blocked`);
    }
  });

  it("asks before a connector action in ask_permission mode and proceeds only after approval", async () => {
    let asked = false;
    const decision = await checkPermission({
      ...makeOpts("mcp_call", "mcp", "ask_permission"),
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
