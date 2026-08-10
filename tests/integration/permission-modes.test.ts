/**
 * Integration tests for the permission mode gate.
 *
 * Tests each of the four permissionMode postures:
 *   manual          — mutating tools ask before running
 *   accept_edits    — fs-write auto-approves; shell still asks
 *   plan            — mutating tools are blocked
 *   bypass_permissions — nothing blocks
 *
 * Tests the gate logic directly without a live session.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkPermission, blockedResult } from "../../src/main/tools/permissions.ts";

/* ---------------------------------------------------------------- helpers */

type PM = "manual" | "accept_edits" | "plan" | "bypass_permissions";

function makeOpts(
  toolName: string,
  toolGroup: string,
  permissionMode: PM,
  answer = "yes",
) {
  return {
    toolName,
    toolGroup,
    permissionMode,
    sessionId: "test-session",
    requestPermission: async (_requestId: string, _reason: string): Promise<string[]> => {
      return [answer];
    },
  };
}

/* ================================================================ bypass_permissions == */

describe("bypass_permissions — nothing blocks or asks", () => {
  it("allows a shell command without asking", async () => {
    const decision = await checkPermission(makeOpts("shell_exec", "shell", "bypass_permissions"));
    assert.equal(decision.allowed, true);
    assert.equal(decision.blockedMessage, null);
  });

  it("allows a filesystem write without asking", async () => {
    const decision = await checkPermission(makeOpts("file_write", "filesystem", "bypass_permissions"));
    assert.equal(decision.allowed, true);
  });

  it("allows a computer use tool without asking", async () => {
    const decision = await checkPermission(makeOpts("computer_click", "computer", "bypass_permissions"));
    assert.equal(decision.allowed, true);
  });
});

/* ================================================================ plan == */

describe("plan — mutating tools are blocked", () => {
  it("blocks shell_exec and returns a plan-request message", async () => {
    const decision = await checkPermission(makeOpts("shell_exec", "shell", "plan"));
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockedMessage, "should have a blocked message");
    assert.match(decision.blockedMessage!, /plan/i);
    assert.match(decision.blockedMessage!, /shell_exec/);
  });

  it("blocks file_write", async () => {
    const decision = await checkPermission(makeOpts("file_write", "filesystem", "plan"));
    assert.equal(decision.allowed, false);
  });

  it("blocks computer use tools", async () => {
    const decision = await checkPermission(makeOpts("computer_type", "computer", "plan"));
    assert.equal(decision.allowed, false);
  });

  it("allows read-only filesystem tools", async () => {
    const decision = await checkPermission(makeOpts("file_read", "filesystem", "plan"));
    assert.equal(decision.allowed, true);
  });

  it("allows glob_match", async () => {
    const decision = await checkPermission(makeOpts("glob_match", "filesystem", "plan"));
    assert.equal(decision.allowed, true);
  });

  it("allows web tools (non-mutating)", async () => {
    const decision = await checkPermission(makeOpts("web_fetch", "web", "plan"));
    assert.equal(decision.allowed, true);
  });
});

/* ================================================================ accept_edits == */

describe("accept_edits — fs writes auto-approve; shell asks", () => {
  it("auto-approves file_write without asking", async () => {
    let wasAsked = false;
    const decision = await checkPermission({
      toolName: "file_write",
      toolGroup: "filesystem",
      permissionMode: "accept_edits",
      sessionId: "s1",
      requestPermission: async () => {
        wasAsked = true;
        return ["yes"];
      },
    });
    assert.equal(decision.allowed, true);
    assert.equal(wasAsked, false, "should not have asked for file writes in accept_edits mode");
  });

  it("asks for shell commands and allows on 'yes'", async () => {
    let wasAsked = false;
    const decision = await checkPermission({
      toolName: "shell_exec",
      toolGroup: "shell",
      permissionMode: "accept_edits",
      sessionId: "s1",
      requestPermission: async () => {
        wasAsked = true;
        return ["yes"];
      },
    });
    assert.equal(decision.allowed, true);
    assert.equal(wasAsked, true, "should have asked for shell commands");
  });

  it("blocks shell commands when user answers 'no'", async () => {
    const decision = await checkPermission(makeOpts("shell_exec", "shell", "accept_edits", "no"));
    assert.equal(decision.allowed, false);
  });

  it("asks for process tools", async () => {
    let wasAsked = false;
    const decision = await checkPermission({
      toolName: "process_start",
      toolGroup: "process",
      permissionMode: "accept_edits",
      sessionId: "s1",
      requestPermission: async () => {
        wasAsked = true;
        return ["yes"];
      },
    });
    assert.equal(decision.allowed, true);
    assert.equal(wasAsked, true);
  });

  it("allows read-only filesystem tools without asking", async () => {
    let wasAsked = false;
    const decision = await checkPermission({
      toolName: "file_read",
      toolGroup: "filesystem",
      permissionMode: "accept_edits",
      sessionId: "s1",
      requestPermission: async () => {
        wasAsked = true;
        return ["yes"];
      },
    });
    assert.equal(decision.allowed, true);
    assert.equal(wasAsked, false);
  });
});

/* ================================================================ manual == */

describe("manual — everything mutating asks", () => {
  it("asks for file_write and allows on 'yes'", async () => {
    let wasAsked = false;
    const decision = await checkPermission({
      toolName: "file_write",
      toolGroup: "filesystem",
      permissionMode: "manual",
      sessionId: "s1",
      requestPermission: async () => {
        wasAsked = true;
        return ["yes"];
      },
    });
    assert.equal(decision.allowed, true);
    assert.equal(wasAsked, true);
  });

  it("asks for shell_exec and blocks on 'no'", async () => {
    const decision = await checkPermission(makeOpts("shell_exec", "shell", "manual", "no"));
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockedMessage);
  });

  it("allows read-only tools without asking", async () => {
    let wasAsked = false;
    const decision = await checkPermission({
      toolName: "file_search",
      toolGroup: "filesystem",
      permissionMode: "manual",
      sessionId: "s1",
      requestPermission: async () => {
        wasAsked = true;
        return ["yes"];
      },
    });
    assert.equal(decision.allowed, true);
    assert.equal(wasAsked, false);
  });

  it("allows web tools without asking", async () => {
    let wasAsked = false;
    const decision = await checkPermission({
      toolName: "web_search",
      toolGroup: "web",
      permissionMode: "manual",
      sessionId: "s1",
      requestPermission: async () => {
        wasAsked = true;
        return ["yes"];
      },
    });
    assert.equal(decision.allowed, true);
    assert.equal(wasAsked, false);
  });
});

/* ================================================================ blockedResult == */

describe("blockedResult helper", () => {
  it("returns a ToolResult with ok:false", () => {
    const r = blockedResult("Permission denied.");
    assert.equal(r.ok, false);
    assert.equal(r.error, "Permission denied.");
    assert.equal(r.content, "Permission denied.");
  });
});

/* ================================================================ custom answer values == */

describe("permission answer normalisation", () => {
  for (const answer of ["yes", "allow", "approve", "y"]) {
    it(`treats "${answer}" as approved`, async () => {
      const decision = await checkPermission(makeOpts("shell_exec", "shell", "manual", answer));
      assert.equal(decision.allowed, true, `answer "${answer}" should be treated as approval`);
    });
  }

  for (const answer of ["no", "deny", "reject", "n", "cancel"]) {
    it(`treats "${answer}" as denied`, async () => {
      const decision = await checkPermission(makeOpts("shell_exec", "shell", "manual", answer));
      assert.equal(decision.allowed, false, `answer "${answer}" should be treated as denial`);
    });
  }
});
