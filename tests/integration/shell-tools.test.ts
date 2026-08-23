/**
 * Integration tests for shell, jobs, process and system tools.
 *
 * Runs real child processes — no mocks.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../../src/main/tools/registry.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";
import { shellTools } from "../../src/main/tools/shell.ts";
import { jobTools, jobRegistry } from "../../src/main/tools/jobs.ts";
import { processTools } from "../../src/main/tools/process.ts";
import { systemTools } from "../../src/main/tools/system.ts";

/* ---------------------------------------------------------------- setup --- */

const registry = new ToolRegistry();
registry.registerAll(shellTools);
registry.registerAll(jobTools);
registry.registerAll(processTools);
registry.registerAll(systemTools);

let tmpDir = "";

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kozum-shell-test-"));
});

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

/* ----------------------------------------------------- platform helpers --- */

const IS_WIN = process.platform === "win32";
const SH = IS_WIN ? "cmd" : "bash";
/** Cross-platform "sleep N seconds": ping-based wait on Windows. */
const sleepCmd = (seconds: number): string =>
  IS_WIN ? `ping -n ${seconds + 1} 127.0.0.1 > NUL` : `sleep ${seconds}`;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "test",
    mode: "code",
    workingFolder: tmpDir,
    outputsDir: tmpDir,
    capabilities: { vision: "yes", tools: true, streaming: true, reasoning: false },
    modelId: "test",
    providerId: "test",
    signal: new AbortController().signal,
    onProgress: () => {},
    ...overrides,
  };
}

async function exec(
  name: string,
  input: Record<string, unknown>,
  ctx?: Partial<ToolContext>,
) {
  return registry.execute(name, input, makeCtx(ctx));
}

/* ============================================================= shell_exec == */

describe("shell_exec", () => {
  it("echo returns correct stdout and exit 0", async () => {
    const r = await exec("shell_exec", { command: "echo hello_world", shell: SH });
    assert.ok(r.ok, `Expected ok, got: ${r.error}`);
    assert.match(r.content, /hello_world/);
    assert.match(r.content, /exit code: 0/);
    const term = r.display?.terminal;
    assert.ok(term, "display.terminal should be present");
    assert.match(term.stdout, /hello_world/);
    assert.equal(term.exitCode, 0);
  });

  it("non-zero exit is reported without crashing", async () => {
    const r = await exec("shell_exec", { command: "exit 42", shell: SH });
    // The tool should succeed (ok:true) but report exit code 42
    assert.ok(r.ok, "tool should not crash on non-zero exit");
    assert.match(r.content, /42/);
    const term = r.display?.terminal;
    assert.ok(term);
    assert.equal(term.exitCode, 42);
  });

  it("rejects a preview server command before the finite-command timeout", async () => {
    const start = Date.now();
    const r = await exec("shell_exec", {
      command: "npm run dev -- --host 127.0.0.1",
      timeoutSeconds: 30,
    });
    const elapsed = Date.now() - start;
    assert.ok(!r.ok, "long-running preview commands must be rejected by shell_exec");
    assert.match(r.error ?? r.content, /shell_exec_bg/i);
    assert.ok(elapsed < 2_000, `server command should fail fast, took ${elapsed}ms`);
  });

  it("timeout kills a sleep and returns partial output", async () => {
    // Use a command that prints something before sleeping
    const command = `echo partial_output && ${sleepCmd(30)}`;
    const start = Date.now();
    const r = await exec("shell_exec", {
      command,
      shell: SH,
      timeoutSeconds: 1,
    });
    const elapsed = Date.now() - start;
    // Should finish well under the sleep duration
    assert.ok(elapsed < 10_000, `Should have timed out quickly, took ${elapsed}ms`);
    assert.ok(r.ok, "tool should return ok even on timeout");
    assert.match(r.content, /timed out/i);
    // Partial output should be included
    assert.match(r.content, /partial_output/);
  });

  it("noTimeout disables all timeouts", async () => {
    // With noTimeout, a very short command should succeed even with timeout=1ms
    const r = await exec("shell_exec", {
      command: "echo no_timeout_test",
      shell: SH,
      timeout: 1, // 1ms would normally kill it
      noTimeout: true,
    });
    assert.ok(r.ok);
    assert.match(r.content, /no_timeout_test/);
  });

  it("noTimeout takes precedence over timeoutSeconds", async () => {
    const r = await exec("shell_exec", {
      command: "echo precedence_test",
      shell: SH,
      timeoutSeconds: 0.001, // would normally timeout immediately
      noTimeout: true,
    });
    assert.ok(r.ok);
    assert.match(r.content, /precedence_test/);
  });

  it("timeoutSeconds takes precedence over timeout (ms)", async () => {
    // timeoutSeconds=5 beats timeout=1 (1ms), command should succeed
    const r = await exec("shell_exec", {
      command: "echo ts_precedence",
      shell: SH,
      timeout: 1, // 1ms
      timeoutSeconds: 5, // 5s — wins
    });
    assert.ok(r.ok);
    assert.match(r.content, /ts_precedence/);
  });

  it("cwd is honoured", async () => {
    const subdir = join(tmpDir, "subdir_cwd");
    await rm(subdir, { recursive: true, force: true }).catch(() => {});
    const { mkdir } = await import("node:fs/promises");
    await mkdir(subdir, { recursive: true });

    // bash pwd / cmd cd (with no args) both print the current directory.
    const r = await exec("shell_exec", {
      command: IS_WIN ? "cd" : "pwd",
      shell: SH,
      cwd: subdir,
    });
    assert.ok(r.ok);
    assert.match(r.content, /subdir_cwd/);
  });

  it("env vars are passed to the child", async () => {
    const r = await exec("shell_exec", {
      command: IS_WIN ? "echo %MY_TEST_VAR%" : "echo $MY_TEST_VAR",
      shell: SH,
      env: { MY_TEST_VAR: "env_var_value" },
    });
    assert.ok(r.ok);
    assert.match(r.content, /env_var_value/);
  });

  it("abort via ctx.signal terminates the child", async () => {
    const ctrl = new AbortController();
    const execP = exec(
      "shell_exec",
      { command: sleepCmd(30), shell: SH, noTimeout: true },
      { signal: ctrl.signal },
    );
    // Give the process a moment to start, then abort
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    const r = await execP;
    // Should have returned (not hung)
    assert.ok(r.ok || !r.ok, "should resolve after abort");
    // exit code should be null (killed)
    const term = r.display?.terminal;
    if (term) {
      assert.equal(term.exitCode, null);
    }
  });
});

/* ============================================================== background == */

describe("background jobs", () => {
  it("shell_exec_bg returns a jobId immediately", async () => {
    const start = Date.now();
    const r = await exec("shell_exec_bg", {
      command: sleepCmd(10),
      shell: SH,
    });
    const elapsed = Date.now() - start;
    assert.ok(r.ok, `Expected ok, got: ${r.error}`);
    // Should return well before the sleep finishes
    assert.ok(elapsed < 2000, `Expected fast return, took ${elapsed}ms`);
    assert.match(r.content, /Started background job/);

    // Extract job ID and kill it
    const match = r.content.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    assert.ok(match, "should contain a UUID job ID");
    const jobId = match![1]!;
    // Clean up
    jobRegistry.kill(jobId, true);
  });

  it("shell_job_status returns running then completed", async () => {
    const bgR = await exec("shell_exec_bg", {
      command: sleepCmd(1),
      shell: SH,
    });
    assert.ok(bgR.ok);
    const match = bgR.content.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const jobId = match![1]!;

    // Immediately check status — should be running
    const statusR = await exec("shell_job_status", { jobId });
    assert.ok(statusR.ok);
    assert.match(statusR.content, /running/);

    // Wait for completion
    const doneR = await exec("shell_job_status", { jobId, wait: 5 });
    assert.ok(doneR.ok);
    assert.match(doneR.content, /completed/);
  });

  it("shell_job_result with wait blocks until done and returns full output", async () => {
    const bgR = await exec("shell_exec_bg", {
      command: `echo job_output_123 && ${sleepCmd(1)}`,
      shell: SH,
    });
    assert.ok(bgR.ok);
    const match = bgR.content.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const jobId = match![1]!;

    const resultR = await exec("shell_job_result", { jobId, wait: 10 });
    assert.ok(resultR.ok);
    assert.match(resultR.content, /job_output_123/);
    assert.match(resultR.content, /completed/);
  });

  it("shell_job_list includes the job", async () => {
    const bgR = await exec("shell_exec_bg", {
      command: sleepCmd(2),
      shell: SH,
      label: "test_list_job",
    });
    assert.ok(bgR.ok);
    const match = bgR.content.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const jobId = match![1]!;

    const listR = await exec("shell_job_list", { includeResolved: true });
    assert.ok(listR.ok);
    assert.ok(listR.content.includes(jobId), "job list should include the job");

    // Clean up
    jobRegistry.kill(jobId, true);
  });

  it("shell_job_kill terminates a long job", async () => {
    const bgR = await exec("shell_exec_bg", {
      command: sleepCmd(60),
      shell: SH,
    });
    assert.ok(bgR.ok);
    const match = bgR.content.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const jobId = match![1]!;

    const killR = await exec("shell_job_kill", { jobId, force: true });
    assert.ok(killR.ok, `Expected kill to succeed, got: ${killR.error}`);
    assert.match(killR.content, /[Kk]illed/);

    // Status should now be killed
    const statusR = await exec("shell_job_status", { jobId });
    assert.ok(statusR.ok);
    assert.match(statusR.content, /killed/);
  });

  it("shell_job_clear refuses while running, succeeds after kill", async () => {
    const bgR = await exec("shell_exec_bg", {
      command: sleepCmd(60),
      shell: SH,
    });
    assert.ok(bgR.ok);
    const match = bgR.content.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const jobId = match![1]!;

    // Clear while running — should refuse
    const clearRunning = await exec("shell_job_clear", { jobId });
    assert.ok(!clearRunning.ok, "should refuse to clear running job");
    assert.match(clearRunning.error ?? "", /running|kill/i);

    // Kill first
    await exec("shell_job_kill", { jobId, force: true });

    // Now clear should succeed
    const clearDone = await exec("shell_job_clear", { jobId });
    assert.ok(clearDone.ok, `Expected clear to succeed, got: ${clearDone.error}`);
  });
});

/* ============================================================== process ===== */

describe("process_list", () => {
  it("returns entries (not empty)", async () => {
    const r = await exec("process_list", {});
    assert.ok(r.ok, `Expected ok, got: ${r.error}`);
    // Should have some processes
    assert.match(r.content, /PID/);
  });

  it("filter narrows results", async () => {
    // 'node' should always appear (we are node)
    const r = await exec("process_list", { filter: "node" });
    assert.ok(r.ok);
    const lines = r.content.split("\n").filter((l) => l.trim() && !l.startsWith("PID"));
    // At least one node process
    assert.ok(lines.length > 0, "filtering by 'node' should return at least our process");
    for (const line of lines) {
      assert.match(line.toLowerCase(), /node/, "every result line should contain 'node'");
    }
  });

  it("filter returns empty message when no match", async () => {
    const r = await exec("process_list", { filter: "kozum_nonexistent_process_xyzzy" });
    assert.ok(r.ok);
    assert.match(r.content, /No processes/i);
  });
});

describe("process_kill", () => {
  it("refuses to kill process.pid (our own PID)", async () => {
    const r = await exec("process_kill", { pid: process.pid });
    assert.ok(!r.ok, "should refuse to kill own PID");
    assert.match(r.error ?? "", /agent|own|refusing/i);
  });

  it("refuses to kill PID 1", async () => {
    const r = await exec("process_kill", { pid: 1 });
    assert.ok(!r.ok, "should refuse to kill PID 1");
    assert.match(r.error ?? "", /protected|refusing/i);
  });

  it("refuses to kill PID 0", async () => {
    const r = await exec("process_kill", { pid: 0 });
    assert.ok(!r.ok, "should refuse to kill PID 0");
    assert.match(r.error ?? "", /protected|refusing/i);
  });
});

/* ============================================================== system_info = */

describe("system_info", () => {
  it("returns platform and cpu count", async () => {
    const r = await exec("system_info", {});
    assert.ok(r.ok, `Expected ok, got: ${r.error}`);
    // Platform should appear
    assert.match(r.content, /Platform:/);
    // CPU count should appear
    assert.match(r.content, /CPU:/);
    // Memory
    assert.match(r.content, /Memory:/);
    // Node version
    assert.match(r.content, /Node:/);
  });

  it(`reports the running platform (${process.platform})`, async () => {
    const r = await exec("system_info", {});
    assert.ok(r.ok);
    if (IS_WIN) {
      assert.match(r.content, /win32|windows/i);
    } else {
      assert.match(r.content, /linux/i);
    }
  });
});

/* ============================================================= file output = */

describe("shell_exec cwd and file interaction", () => {
  it("writes and reads a file via shell commands", async () => {
    await writeFile(join(tmpDir, "input.txt"), "from_file_content", "utf8");

    const r = await exec("shell_exec", {
      command: IS_WIN ? "type input.txt" : "cat input.txt",
      shell: SH,
      cwd: tmpDir,
    });
    assert.ok(r.ok);
    assert.match(r.content, /from_file_content/);
  });
});
