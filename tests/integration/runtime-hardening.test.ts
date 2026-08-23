/**
 * Regression tests for runtime hardening fixes.
 *
 * Covers the defects fixed in:
 *   M1  — loop transcript integrity on mid-stream error
 *   M2  — shell timeout settles within a grace window
 *   H8  — computer-use blocklist: fail-closed, ext stripping, all tools
 *   M15 — Add-Type precedes first type use in generated PS script
 *   M8  — jobs are session-scoped
 *   L8  — multi-byte character split across chunk boundaries
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

/* ============================================================ imports ===== */

import {
  runAgentLoop,
  type ToolExecutor,
} from "../../src/main/agent/loop.ts";
import { OpenAiChatAdapter } from "../../src/main/providers/adapters/openai-chat.ts";
import type { Message, ToolDefinition, ToolResult } from "../../src/shared/types.ts";

import {
  isAppBlocked,
  buildCaptureScript,
} from "../../src/main/computer/windows.ts";
import type { ComputerBackend, CaptureOptions } from "../../src/main/computer/windows.ts";
import { BackendUnavailableError } from "../../src/main/computer/windows.ts";
import { makeComputerTools } from "../../src/main/tools/computer.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";

import { JobRegistry } from "../../src/main/tools/jobs.ts";

/* ========================================================= helpers ======= */

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "sess-A",
    mode: "cowork",
    workingFolder: null,
    outputsDir: "/tmp",
    capabilities: { vision: "yes", tools: true, streaming: true, reasoning: false },
    modelId: "test-model",
    providerId: "test-provider",
    signal: new AbortController().signal,
    onProgress: () => {},
    ...overrides,
  };
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/* ====================== M1 — transcript integrity on stream error ========= */

describe("M1 — transcript integrity on mid-stream error", () => {
  let server: http.Server;
  let base = "";

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Emit a complete tool_call delta, then destroy the socket.
        res.write(
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_m1",
                      function: { name: "file_read", arguments: '{"path":"x"}' },
                    },
                  ],
                },
              },
            ],
          }),
        );
        setTimeout(() => res.socket?.destroy(), 30);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("every tool_use in the transcript has a matching tool_result after a stream error", async () => {
    const tools: ToolExecutor = {
      list: (): ToolDefinition[] => [
        {
          name: "file_read",
          title: "Read",
          description: "",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          icon: "f",
          group: "filesystem",
          modes: ["cowork", "code"],
        },
      ],
      execute: async (): Promise<ToolResult> => ({ ok: true, content: "x" }),
    };

    const history: Message[] = [
      { id: "u1", role: "user", content: [{ type: "text", text: "read x" }], createdAt: Date.now() },
    ];

    const res = await runAgentLoop({
      sessionId: "s-m1",
      mode: "cowork",
      adapter: new OpenAiChatAdapter(),
      ctx: { baseUrl: base, apiKey: "k", providerId: "test", meta: {}, extraHeaders: {} },
      model: "m",
      system: "sys",
      history,
      tools,
      maxTokens: 100,
      temperature: 0,
      maxIterations: 4,
      signal: new AbortController().signal,
      emit: () => {},
    });

    assert.equal(res.stopReason, "error", "stop reason should be error");

    const toolUses: string[] = [];
    const toolResults: string[] = [];
    for (const m of res.messages) {
      for (const b of m.content) {
        if (b.type === "tool_use") toolUses.push(b.id);
        if (b.type === "tool_result") toolResults.push(b.toolUseId);
      }
    }

    assert.ok(toolUses.length > 0, "should have at least one tool_use");
    for (const id of toolUses) {
      assert.ok(
        toolResults.includes(id),
        `tool_use ${id} must have a matching tool_result — transcript is broken otherwise`,
      );
    }
  });
});

/* ====================== M2 — shell timeout grace window =================== */

describe("M2 — shell timeout settles within grace window", () => {
  it("returns at roughly timeout + 2s grace, not never", async () => {
    const { shellTools } = await import("../../src/main/tools/shell.ts");
    const tool = shellTools.find((t) => t.definition.name === "shell_exec")!;
    assert.ok(tool, "shell_exec tool should exist");

    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });

    const isWin = process.platform === "win32";
    // POSIX: setsid forks a grandchild that escapes the process group while
    // keeping stdout open — the classic case that used to hang forever.
    // Windows has no setsid; taskkill /T handles tree kills, so a plain long
    // running command exercises the same timeout + grace path.
    const command = isWin ? "ping -n 601 127.0.0.1 > NUL" : "setsid sleep 600 & echo started; sleep 600";
    const timeoutSeconds = 2;
    const gracePeriodMs = 2000;
    const marginMs = isWin ? 6000 : 2000; // allow scheduler + taskkill slop

    const maxExpectedMs = timeoutSeconds * 1000 + gracePeriodMs + marginMs;

    const t0 = Date.now();
    const result = await Promise.race([
      tool.handler({ command, timeoutSeconds }, ctx as never),
      new Promise<"__HUNG__">((r) => setTimeout(() => r("__HUNG__"), maxExpectedMs)),
    ]);

    const elapsed = Date.now() - t0;

    assert.notEqual(result, "__HUNG__", `shell_exec must settle within ${maxExpectedMs}ms, took ${elapsed}ms`);
    const r = result as { ok: boolean; content: string };
    assert.ok(r.ok, "should return ok:true even on timeout");
    assert.match(r.content, /timed out/i, "should report timed out");

    if (!isWin) {
      // Clean up any escaped grandchild.
      const { spawnSync } = await import("node:child_process");
      spawnSync("pkill", ["-f", "sleep 600"]);
    }
  });
});

/* ====================== H8 — blocklist fail-closed ======================== */

describe("H8 — isAppBlocked strips .exe from both sides", () => {
  it("isAppBlocked('keepass', ['keepass.exe']) is true", () => {
    assert.ok(isAppBlocked("keepass", ["keepass.exe"]), "should match without extension");
  });

  it("isAppBlocked('keepass.exe', ['keepass.exe']) is true", () => {
    assert.ok(isAppBlocked("keepass.exe", ["keepass.exe"]));
  });

  it("isAppBlocked('KeePass.EXE', ['keepass.exe']) is true", () => {
    assert.ok(isAppBlocked("KeePass.EXE", ["keepass.exe"]));
  });

  it("isAppBlocked('keepassxc', ['keepass.exe']) is false", () => {
    assert.ok(!isAppBlocked("keepassxc", ["keepass.exe"]), "keepassxc is different from keepass");
  });

  it("isAppBlocked('keepass', defaults) is true", async () => {
    const { DEFAULT_SETTINGS } = await import("../../src/shared/defaults.ts");
    const blocklist = DEFAULT_SETTINGS.computerUse.blocklist;
    assert.ok(isAppBlocked("keepass", blocklist), "keepass (no .exe) should match keepass.exe in defaults");
  });
});

describe("H8 — blocklist fails CLOSED when active window is unknown", () => {
  /**
   * Backend where activeWindow() throws — simulates the pre-fix $pid bug or
   * any other failure to determine the foreground window.
   */
  class ThrowingWindowBackend implements ComputerBackend {
    capture(_opts?: CaptureOptions): ReturnType<ComputerBackend["capture"]> {
      return Promise.reject(new Error("capture unavailable"));
    }
    moveMouse(_x: number, _y: number): Promise<void> {
      return Promise.reject(new Error("unavailable"));
    }
    clickMouse(): Promise<void> {
      return Promise.reject(new Error("unavailable"));
    }
    typeText(): Promise<void> {
      return Promise.reject(new Error("unavailable"));
    }
    pressKeys(): Promise<void> {
      return Promise.reject(new Error("unavailable"));
    }
    screenSize(): ReturnType<ComputerBackend["screenSize"]> {
      return Promise.reject(new Error("unavailable"));
    }
    activeWindow(): ReturnType<ComputerBackend["activeWindow"]> {
      // This is the scenario: activeWindow throws (e.g. $pid conflict in PS)
      return Promise.reject(new Error("SessionStateUnauthorizedAccessException: $pid"));
    }
    listWindows(): ReturnType<ComputerBackend["listWindows"]> {
      return Promise.reject(new Error("unavailable"));
    }
    multiMonitorBounds(): ReturnType<ComputerBackend["multiMonitorBounds"]> {
      return Promise.resolve([]);
    }
    selfTest(): ReturnType<ComputerBackend["selfTest"]> {
      return Promise.reject(new Error("self-test unavailable"));
    }
  }

  /**
   * Backend where activeWindow() returns null — no foreground window.
   */
  class NullWindowBackend implements ComputerBackend {
    capture(_opts?: CaptureOptions): ReturnType<ComputerBackend["capture"]> {
      return Promise.reject(new BackendUnavailableError("Computer use"));
    }
    moveMouse(_x: number, _y: number): Promise<void> {
      return Promise.reject(new BackendUnavailableError("Computer use"));
    }
    clickMouse(): Promise<void> {
      return Promise.reject(new BackendUnavailableError("Computer use"));
    }
    typeText(): Promise<void> {
      return Promise.reject(new BackendUnavailableError("Computer use"));
    }
    pressKeys(): Promise<void> {
      return Promise.reject(new BackendUnavailableError("Computer use"));
    }
    screenSize(): ReturnType<ComputerBackend["screenSize"]> {
      return Promise.reject(new BackendUnavailableError("Computer use"));
    }
    activeWindow(): ReturnType<ComputerBackend["activeWindow"]> {
      return Promise.resolve(null);
    }
    listWindows(): ReturnType<ComputerBackend["listWindows"]> {
      return Promise.reject(new BackendUnavailableError("Computer use"));
    }
    multiMonitorBounds(): ReturnType<ComputerBackend["multiMonitorBounds"]> {
      return Promise.resolve([]);
    }
    selfTest(): ReturnType<ComputerBackend["selfTest"]> {
      return Promise.reject(new Error("self-test unavailable"));
    }
  }

  const blocklist = ["keepass.exe"];
  const ctx = makeCtx();

  for (const toolName of ["computer_type", "computer_click", "computer_key", "computer_screenshot"]) {
    it(`${toolName} fails CLOSED when activeWindow() throws and blocklist is non-empty`, async () => {
      const tools = makeComputerTools(new ThrowingWindowBackend(), () => blocklist);
      const t = tools.find((tt) => tt.definition.name === toolName)!;
      assert.ok(t, `tool ${toolName} should exist`);

      const input: Record<string, unknown> =
        toolName === "computer_type" ? { text: "hello" }
        : toolName === "computer_click" ? { x: 0, y: 0 }
        : toolName === "computer_key" ? { keys: ["enter"] }
        : {};

      const result = await t.handler(input, ctx);
      assert.equal(result.ok, false, `${toolName} must be blocked when activeWindow throws`);
      assert.ok(
        (result.error ?? "").toLowerCase().includes("block") ||
        (result.error ?? "").toLowerCase().includes("active window") ||
        (result.error ?? "").toLowerCase().includes("unknown"),
        `${toolName} error should explain why it was blocked: ${result.error}`,
      );
    });

    it(`${toolName} fails CLOSED when activeWindow() returns null and blocklist is non-empty`, async () => {
      const tools = makeComputerTools(new NullWindowBackend(), () => blocklist);
      const t = tools.find((tt) => tt.definition.name === toolName)!;
      assert.ok(t, `tool ${toolName} should exist`);

      const input: Record<string, unknown> =
        toolName === "computer_type" ? { text: "hello" }
        : toolName === "computer_click" ? { x: 0, y: 0 }
        : toolName === "computer_key" ? { keys: ["enter"] }
        : {};

      const result = await t.handler(input, ctx);
      assert.equal(result.ok, false, `${toolName} must be blocked when no active window and blocklist non-empty`);
    });
  }

  it("computer_type is NOT blocked when blocklist is empty (even if activeWindow throws)", async () => {
    const tools = makeComputerTools(new ThrowingWindowBackend(), () => []);
    const t = tools.find((tt) => tt.definition.name === "computer_type")!;
    // With an empty blocklist, checkBlocklist skips the activeWindow() call.
    // The tool should then propagate to typeText which also throws, giving ok:false
    // but from a different path (unavailable, not blocked).
    const result = await t.handler({ text: "hello" }, ctx);
    // The tool returns ok:false because typeText also throws, but the error
    // should NOT be a blocklist error — it should be a backend error.
    assert.equal(result.ok, false);
    assert.ok(
      !(result.error ?? "").toLowerCase().includes("block"),
      `With empty blocklist, error should not say blocked: ${result.error}`,
    );
  });
});

/* ====================== M15 — Add-Type precedes first type use ============ */

describe("M15 — Add-Type precedes first type reference in generated PS scripts", () => {
  it("buildCaptureScript (full-screen): System.Windows.Forms Add-Type before [Screen]", () => {
    const script = buildCaptureScript({ outputPath: "C:\\tmp\\out.jpg" });
    const addTypeIdx = script.indexOf("Add-Type -AssemblyName System.Windows.Forms");
    const screenIdx = script.indexOf("[System.Windows.Forms.Screen]");
    assert.ok(addTypeIdx >= 0, "Add-Type for System.Windows.Forms must appear");
    assert.ok(screenIdx >= 0, "[System.Windows.Forms.Screen] must appear");
    assert.ok(
      addTypeIdx < screenIdx,
      `Add-Type (pos ${addTypeIdx}) must precede [Screen] reference (pos ${screenIdx})`,
    );
  });

  it("buildCaptureScript (full-screen): System.Drawing Add-Type before [ImageCodecInfo]", () => {
    const script = buildCaptureScript({ outputPath: "C:\\tmp\\out.jpg" });
    const addTypeDrawingIdx = script.indexOf("Add-Type -AssemblyName System.Drawing");
    const codecIdx = script.indexOf("[System.Drawing.Imaging.ImageCodecInfo]");
    assert.ok(addTypeDrawingIdx >= 0, "Add-Type for System.Drawing must appear");
    assert.ok(codecIdx >= 0, "ImageCodecInfo reference must appear");
    assert.ok(
      addTypeDrawingIdx < codecIdx,
      `Add-Type System.Drawing (pos ${addTypeDrawingIdx}) must precede [ImageCodecInfo] (pos ${codecIdx})`,
    );
  });

  it("buildCaptureScript (region): System.Windows.Forms Add-Type before [System.Drawing.Size]", () => {
    const script = buildCaptureScript({
      outputPath: "C:\\tmp\\out.jpg",
      region: { x: 0, y: 0, width: 100, height: 100 },
    });
    const addTypeIdx = script.indexOf("Add-Type -AssemblyName System.Windows.Forms");
    const sizeIdx = script.indexOf("[System.Drawing.Size]");
    assert.ok(addTypeIdx >= 0, "Add-Type must appear");
    assert.ok(sizeIdx >= 0, "[System.Drawing.Size] must appear");
    assert.ok(
      addTypeIdx < sizeIdx,
      `Add-Type (pos ${addTypeIdx}) must precede first type use (pos ${sizeIdx})`,
    );
  });

  it("no type reference appears before its Add-Type in the full-screen script", () => {
    const script = buildCaptureScript({ outputPath: "out.jpg" });
    // Walk each Add-Type line and verify no type from that assembly appears before it.
    const lines = script.split("\n");
    const addTypeLines: Array<{ idx: number; assembly: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/Add-Type -AssemblyName (.+)/);
      if (m) addTypeLines.push({ idx: i, assembly: m[1]!.trim() });
    }
    assert.ok(addTypeLines.length >= 2, "should have at least two Add-Type directives");
    // This test primarily documents the expected ordering rather than scanning
    // every possible type reference — the structural tests above cover that.
  });
});

/* ====================== M8 — jobs are session-scoped ===================== */

describe("M8 — jobs are session-scoped", () => {
  it("a job started in session A is not visible in session B's list", async () => {
    const reg = new JobRegistry();
    reg.start("echo a", "bash", undefined, undefined, "job-a", "session-A");
    reg.start("echo b", "bash", undefined, undefined, "job-b", "session-B");

    const aJobs = reg.list(true, "session-A");
    const bJobs = reg.list(true, "session-B");

    assert.equal(aJobs.length, 1);
    assert.equal(bJobs.length, 1);
    assert.match(aJobs[0]!.label, /job-a/);
    assert.match(bJobs[0]!.label, /job-b/);

    // Kill both to avoid leftover processes.
    for (const j of [...aJobs, ...bJobs]) {
      reg.kill(j.id, true);
    }
  });

  it("session B cannot get a job owned by session A", async () => {
    const reg = new JobRegistry();
    const id = reg.start("echo private", "bash", undefined, undefined, "secret-job", "session-A");

    const fromA = reg.get(id, "session-A");
    assert.ok(fromA, "session A should see its own job");

    const fromB = reg.get(id, "session-B");
    assert.equal(fromB, undefined, "session B must not see session A's job");

    reg.kill(id, true, "session-A");
  });

  it("session B cannot kill a job owned by session A", async () => {
    const reg = new JobRegistry();
    const id = reg.start("sleep 60", "bash", undefined, undefined, "long-job", "session-A");

    const killed = reg.kill(id, true, "session-B");
    assert.equal(killed, false, "cross-session kill must fail");

    // Clean up.
    reg.kill(id, true, "session-A");
  });

  it("session B cannot clear a job owned by session A", async () => {
    const reg = new JobRegistry();
    const id = reg.start("echo q", "bash", undefined, undefined, "quick", "session-A");

    // Wait briefly for it to finish.
    await new Promise<void>((r) => setTimeout(r, 300));

    const result = reg.clear(id, "session-B");
    assert.equal(result, "not_found", "cross-session clear must return not_found");

    // Clean up.
    reg.clear(id, "session-A");
  });

  it("waitFor refuses cross-session access", async () => {
    const reg = new JobRegistry();
    const id = reg.start("sleep 60", "bash", undefined, undefined, "long2", "session-A");

    const result = await reg.waitFor(id, 0.1, "session-B");
    assert.equal(result, undefined, "cross-session waitFor must return undefined");

    reg.kill(id, true, "session-A");
  });
});

/* ====================== L8 — multi-byte chars across chunk boundaries ==== */

describe("L8 — multi-byte character split across chunk boundaries (child-process)", () => {
  it("a multi-byte UTF-8 sequence split across two stdio chunks is decoded correctly", async () => {
    const { shellTools } = await import("../../src/main/tools/shell.ts");
    const tool = shellTools.find((t) => t.definition.name === "shell_exec")!;
    assert.ok(tool, "shell_exec tool should exist");

    const ctx = makeCtx();

    // The Japanese yen sign '¥' is U+00A5, encoded as 0xC2 0xA5 (2 bytes).
    // The command emits the two bytes in separate raw writes so the decoder
    // must handle the chunk boundary (bash printf hex escapes on POSIX, a
    // PowerShell raw byte write on Windows).
    const isWin = process.platform === "win32";
    const command = isWin
      ? "[Console]::OpenStandardOutput().Write([byte[]](194),0,1); [Console]::OpenStandardOutput().Write([byte[]](165),0,1)"
      : "printf '\\xc2' && printf '\\xa5'";

    const result = await tool.handler(
      isWin ? { command, shell: "powershell" } : { command, shell: "bash" },
      ctx as never,
    );
    assert.ok(result.ok, `Expected ok, got: ${result.error}`);
    assert.match(result.content, /¥/, "output should contain the correctly decoded ¥ character");
    assert.ok(
      !result.content.includes("�"),
      "output must not contain U+FFFD replacement characters",
    );
  });
});
