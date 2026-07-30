/**
 * Unit tests for toolIcons.ts
 *
 * Run with:
 *   node --experimental-strip-types --test tests/unit/toolIcons.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolIcon, type ToolIconInfo } from "../../src/renderer/lib/toolIcons.ts";

function assertInfo(result: ToolIconInfo, icon: string, labelContains: string) {
  assert.equal(result.icon, icon, `Expected icon "${icon}" but got "${result.icon}"`);
  assert.ok(
    result.label.length > 0,
    `Expected a non-empty label but got "${result.label}"`,
  );
  assert.ok(
    result.label.toLowerCase().includes(labelContains.toLowerCase()),
    `Expected label to contain "${labelContains}" but got "${result.label}"`,
  );
}

// ── Exact matches ─────────────────────────────────────────────────────────

describe("toolIcon — exact matches", () => {
  it("shell_exec → terminal / Run command", () => {
    assertInfo(toolIcon("shell_exec"), "terminal", "command");
  });

  it("file_write → file-plus / Write file", () => {
    assertInfo(toolIcon("file_write"), "file-plus", "write");
  });

  it("file_read → file-text / Read file", () => {
    assertInfo(toolIcon("file_read"), "file-text", "read");
  });

  it("web_fetch → globe / Fetch URL", () => {
    assertInfo(toolIcon("web_fetch"), "globe", "fetch");
  });

  it("web_search → search / Web search", () => {
    assertInfo(toolIcon("web_search"), "search", "search");
  });

  it("browser_navigate → compass", () => {
    assertInfo(toolIcon("browser_navigate"), "compass", "navigate");
  });

  it("browser_screenshot → camera", () => {
    assertInfo(toolIcon("browser_screenshot"), "camera", "screenshot");
  });

  it("computer_screenshot → monitor", () => {
    assertInfo(toolIcon("computer_screenshot"), "monitor", "screenshot");
  });

  it("computer_click → mouse-pointer-2", () => {
    assertInfo(toolIcon("computer_click"), "mouse-pointer-2", "click");
  });

  it("agent_spawn → bot", () => {
    assertInfo(toolIcon("agent_spawn"), "bot", "agent");
  });

  it("task_create → list-checks", () => {
    assertInfo(toolIcon("task_create"), "list-checks", "task");
  });

  it("skill_run → sparkles", () => {
    assertInfo(toolIcon("skill_run"), "sparkles", "skill");
  });

  it("mcp_call → plug", () => {
    assertInfo(toolIcon("mcp_call"), "plug", "mcp");
  });

  it("plugin_run → package", () => {
    assertInfo(toolIcon("plugin_run"), "package", "plugin");
  });

  it("schedule_create → calendar", () => {
    assertInfo(toolIcon("schedule_create"), "calendar", "schedule");
  });

  it("memory_read → brain", () => {
    assertInfo(toolIcon("memory_read"), "brain", "memory");
  });

  it("grep → search", () => {
    assertInfo(toolIcon("grep"), "search", "search");
  });
});

// ── Prefix fallbacks ──────────────────────────────────────────────────────

describe("toolIcon — prefix fallbacks", () => {
  it("unknown shell_ prefix → terminal", () => {
    assertInfo(toolIcon("shell_new_thing"), "terminal", "command");
  });

  it("unknown file_ prefix → file", () => {
    const result = toolIcon("file_something_new");
    assert.equal(result.icon, "file");
  });

  it("unknown dir_ prefix → folder", () => {
    const result = toolIcon("dir_something_new");
    assert.equal(result.icon, "folder");
  });

  it("unknown web_ prefix → globe", () => {
    const result = toolIcon("web_new_operation");
    assert.equal(result.icon, "globe");
  });

  it("unknown browser_ prefix → compass", () => {
    const result = toolIcon("browser_new_action");
    assert.equal(result.icon, "compass");
  });

  it("unknown computer_ prefix → monitor", () => {
    const result = toolIcon("computer_new_action");
    assert.equal(result.icon, "monitor");
  });

  it("unknown mcp_ prefix → plug", () => {
    const result = toolIcon("mcp_new_tool");
    assert.equal(result.icon, "plug");
  });

  it("unknown plugin_ prefix → package", () => {
    const result = toolIcon("plugin_new_op");
    assert.equal(result.icon, "package");
  });

  it("unknown schedule_ prefix → calendar", () => {
    const result = toolIcon("schedule_new_op");
    assert.equal(result.icon, "calendar");
  });

  it("unknown memory_ prefix → brain", () => {
    const result = toolIcon("memory_new_op");
    assert.equal(result.icon, "brain");
  });

  it("unknown agent_ prefix → bot", () => {
    const result = toolIcon("agent_new_op");
    assert.equal(result.icon, "bot");
  });

  it("unknown skill_ prefix → sparkles", () => {
    const result = toolIcon("skill_new_op");
    assert.equal(result.icon, "sparkles");
  });

  it("unknown task_ prefix → list-checks", () => {
    const result = toolIcon("task_new_op");
    assert.equal(result.icon, "list-checks");
  });

  it("process_ prefix → terminal", () => {
    const result = toolIcon("process_new");
    assert.equal(result.icon, "terminal");
  });
});

// ── Fallback ──────────────────────────────────────────────────────────────

describe("toolIcon — fallback", () => {
  it("completely unknown tool → wrench icon with tool name as label", () => {
    const result = toolIcon("totally_unknown_xyz");
    assert.equal(result.icon, "wrench");
    assert.equal(result.label, "totally_unknown_xyz");
  });

  it("empty string → wrench", () => {
    const result = toolIcon("");
    assert.equal(result.icon, "wrench");
  });
});

// ── Non-regression: exact wins over prefix ────────────────────────────────

describe("toolIcon — exact beats prefix", () => {
  it("shell_exec returns specific label, not generic prefix label", () => {
    const exact = toolIcon("shell_exec");
    const prefixed = toolIcon("shell_something_else");
    // Both are terminal, but exact has a more specific label
    assert.equal(exact.icon, "terminal");
    assert.equal(prefixed.icon, "terminal");
    assert.equal(exact.label, "Run command");
  });

  it("file_write returns file-plus, not generic file", () => {
    assertInfo(toolIcon("file_write"), "file-plus", "write");
  });

  it("file_read returns file-text, not generic file", () => {
    assertInfo(toolIcon("file_read"), "file-text", "read");
  });
});

// ── Return shape ──────────────────────────────────────────────────────────

describe("toolIcon — return shape", () => {
  it("always returns an object with icon and label strings", () => {
    for (const name of [
      "shell_exec",
      "file_read",
      "web_fetch",
      "browser_click",
      "totally_unknown",
    ]) {
      const result = toolIcon(name);
      assert.ok(typeof result.icon === "string" && result.icon.length > 0);
      assert.ok(typeof result.label === "string" && result.label.length > 0);
    }
  });
});
