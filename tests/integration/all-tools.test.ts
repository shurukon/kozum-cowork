/**
 * Full built-in tool coverage.
 *
 * This suite dispatches every cowork tool through the production registry and
 * production handlers. It uses only temporary real files/processes and real
 * service implementations. Browser/computer/MCP limitations are asserted as
 * explicit capability boundaries rather than hidden or mocked successes.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";

import { buildToolRegistry } from "../../src/main/tools/index.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";
import { TaskStore } from "../../src/main/tools/tasks.ts";
import { AskBroker } from "../../src/main/tools/ask.ts";
import { SubagentManager } from "../../src/main/agent/subagents.ts";
import { SkillStore } from "../../src/main/skills/index.ts";
import { MemoryVault } from "../../src/main/memory/vault.ts";
import { Scheduler } from "../../src/main/schedule/scheduler.ts";
import { McpManager } from "../../src/main/mcp/manager.ts";
import { PluginManager } from "../../src/main/plugins/manager.ts";
import { BrowserEngine, ElectronBrowserBackend } from "../../src/main/browser/engine.ts";

let root = "";
let workspace = "";
let registry: ReturnType<typeof buildToolRegistry>;
let ask: AskBroker;
let scheduler: Scheduler;
let plugins: PluginManager;
let victim: ReturnType<typeof spawn>;

const context = (): ToolContext => ({
  sessionId: "all-tools-test",
  mode: "cowork",
  workingFolder: workspace,
  outputsDir: join(root, "outputs"),
  capabilities: { vision: "yes", tools: true, streaming: true, reasoning: false },
  modelId: "integration-test-model",
  providerId: "integration-test-provider",
  signal: new AbortController().signal,
  onProgress: (_note: string) => {},
  onQuestion: (payload) => {
    ask.resolve(payload.requestId, [payload.options[0]?.value ?? "ok"]);
  },
});

function text(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    if (typeof record.error === "string") return record.error;
  }
  return String(value ?? "");
}

function id(value: unknown, pattern: RegExp): string {
  return text(value).match(pattern)?.[1] ?? "";
}

async function execute(name: string, input: Record<string, unknown>) {
  const result = await registry.execute(name, input, context());
  assert.ok(result && typeof result.ok === "boolean", `${name} returned an invalid ToolResult`);
  return result;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "kozum-all-tools-"));
  workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "seed.txt"), "seed content\n", "utf8");
  await writeFile(
    join(workspace, "pixel.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  const pdfText = "BT /F1 12 Tf 72 720 Td (Kozum Cowork test PDF) Tj ET";
  await writeFile(
    join(workspace, "sample.pdf"),
    `%PDF-1.4\n1 0 obj\n<< /Length ${Buffer.byteLength(pdfText)} >>\nstream\n${pdfText}\nendstream\nendobj\n%%EOF\n`,
    "binary",
  );

  const memory = new MemoryVault(join(root, "memory"));
  await memory.init();
  ask = new AskBroker();
  const skills = new SkillStore();
  skills.register({
    id: "skill_all_tools",
    name: "all-tools-skill",
    description: "Deterministic integration skill.",
    path: join(root, "SKILL.md"),
    source: "user",
    enabled: true,
    modes: ["cowork", "code"],
    body: "All-tools skill body.",
  });
  const subagents = new SubagentManager(async ({ prompt }) => ({ text: `completed: ${prompt}` }));
  scheduler = new Scheduler({ rootDir: join(root, "schedule"), runner: async () => undefined });
  const mcp = new McpManager();
  plugins = new PluginManager(join(root, "plugins"));
  const browser = new BrowserEngine(new ElectronBrowserBackend(), { timeoutMs: 1_000, retries: 0 });
  registry = buildToolRegistry({
    tasks: new TaskStore(),
    ask,
    subagents,
    skills,
    memory,
    scheduler,
    mcp,
    plugins,
    browser,
    getComputerBlocklist: () => [],
  });
  victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });

  const pluginSource = join(root, "plugin-src");
  await mkdir(join(pluginSource, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(pluginSource, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "all-tools-plugin", description: "Integration plugin", version: "1.0.0" }),
    "utf8",
  );
  // adm-zip instead of the `zip` CLI — Windows has no zip binary by default.
  const zip = new AdmZip();
  zip.addLocalFolder(pluginSource);
  zip.writeZip(join(root, "all-tools-plugin.zip"));
});

after(async () => {
  if (victim.pid) victim.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
});

describe("complete production registry coverage", () => {
  it("registers exactly 86 cowork tools", () => {
    const tools = registry.list("cowork");
    assert.equal(tools.length, 86);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, 86);
  });

  it("executes every tool with real inputs or an explicit capability boundary", async () => {
    const state = { jobId: "", killJobId: "", memoryId: "", taskId: "", scheduleId: "", agentId: "", pluginId: "" };
    const killJob = await execute("shell_exec_bg", {
      // Long enough that the job cannot complete before the kill step below,
      // even when the full-matrix tool sweep runs slowly under load.
      command: process.platform === "win32" ? "ping -n 601 127.0.0.1 > NUL" : "sleep 600",
      label: "kill test",
    });
    state.killJobId = id(killJob, /Started background job\s+([\w-]+)/i);
    assert.ok(state.killJobId, text(killJob));

    const inputFor = (name: string): Record<string, unknown> => {
      const inputs: Record<string, Record<string, unknown>> = {
        file_read: { path: "seed.txt" },
        file_write: { path: "generated.txt", content: "generated by real tool smoke\n" },
        file_edit: { path: "generated.txt", oldString: "real tool", newString: "REAL TOOL" },
        file_edit_enhanced: { path: "generated.txt", oldString: "REAL TOOL", newString: "FINAL TOOL" },
        file_read_image: { path: "pixel.png" },
        file_read_pdf: { path: "sample.pdf" },
        file_copy: { source: "seed.txt", destination: "seed-copy.txt" },
        file_move: { source: "seed-copy.txt", destination: "seed-moved.txt" },
        file_delete: { path: "seed-moved.txt" },
        directory_create: { path: "created-dir" },
        directory_list: { path: "." },
        directory_delete: { path: "created-dir", recursive: true },
        file_search: { pattern: "seed", path: "." },
        glob_match: { pattern: "**/*.txt", root: "." },
        env_get: { name: "PATH" },
        env_set: { name: "KOZUM_SMOKE_VAR", value: "ok" },
        shell_exec: { command: process.platform === "win32" ? "echo shell smoke" : "printf 'shell smoke\\n'" },
        shell_exec_bg: { command: "printf 'background smoke\\n'" },
        shell_job_list: { includeResolved: true },
        shell_job_status: { jobId: state.jobId, wait: 5 },
        shell_job_result: { jobId: state.jobId, wait: 5, maxBytes: 4096 },
        shell_job_clear: { jobId: state.jobId },
        shell_job_kill: { jobId: state.killJobId, force: true },
        process_list: {},
        process_kill: { pid: victim.pid, force: true },
        system_info: {},
        web_fetch: { url: "https://example.com" },
        web_search: { query: "OpenAI", limit: 3, includeContent: false },
        browser_navigate: { url: "about:blank" },
        browser_wait: { milliseconds: 1 },
        browser_back: {}, browser_forward: {}, browser_close: {},
        browser_get_content: { type: "text" }, browser_screenshot: { fullPage: false },
        browser_scroll: { direction: "down", amount: 1 }, browser_click: { x: 1, y: 1 },
        browser_type: { selector: "body", text: "smoke", submit: false },
        browser_extract: { instruction: "return the page title", schema: {} },
        screenshot: { input: "https://example.com" }, pixelshot_help: {},
        memory_write: { title: "smoke", type: "project", description: "smoke memory", body: "smoke body" },
        memory_list: { type: "project" }, memory_search: { query: "smoke", limit: 10 },
        memory_read: { id: state.memoryId }, memory_delete: { id: state.memoryId },
        project_kb_build: { path: "." }, project_kb_update: { path: "." },
        task_create: { subject: "smoke task", description: "smoke task description" }, task_list: {},
        task_get: { taskId: state.taskId }, task_update: { taskId: state.taskId, subject: "updated", status: "in_progress" },
        task_stop: { taskId: state.taskId }, schedule_list: {},
        schedule_create: { name: "smoke schedule", prompt: "smoke", cron: "0 0 * * *" },
        schedule_run_now: { id: state.scheduleId }, schedule_update: { id: state.scheduleId, name: "updated", cron: "0 1 * * *" },
        schedule_delete: { id: state.scheduleId }, skill_list: {}, skill_invoke: { skill: "all-tools-skill" },
        agent_list: {}, agent_run: { description: "smoke agent", prompt: "return immediately", acceptance_criteria: ["Runner returns evidence"] },
        agent_status: { agentId: state.agentId }, agent_cancel: { agentId: state.agentId },
        marketplace_list: { id: "missing-marketplace" }, marketplace_add: { source: "https://example.com/marketplace.json" },
        plugin_install: { source: join(root, "all-tools-plugin.zip") }, plugin_list: {},
        plugin_disable: { id: state.pluginId }, plugin_enable: { id: state.pluginId }, plugin_uninstall: { id: state.pluginId },
        mcp_list: {}, mcp_list_tools: {}, mcp_call: { serverId: "missing-server", tool: "missing-tool", args: {} },
        preview_open: { path: "generated.txt" },
        mcp_install: { name: "smoke", transport: "stdio", command: "missing-command" }, mcp_remove: { id: "missing-server" },
        computer_self_test: {}, computer_list_windows: {}, computer_screen_size: {}, computer_screenshot: { x: 0, y: 0, width: 1, height: 1 },
        computer_move: { x: 1, y: 1 }, computer_click: { x: 1, y: 1, button: "left" }, computer_key: { keys: ["ESC"] }, computer_type: { text: "smoke" },
        ask_user_question: { question: "smoke", options: [{ label: "ok", value: "ok" }] },
      };
      return inputs[name] ?? {};
    };

    const expectedBoundary = /unavailable outside|outside the Kozum Cowork Electron app|outside Windows/i;
    const expectedExternal = /DuckDuckGo returned no parseable results|Could not reach DuckDuckGo/i;
    const expectedContract = /not found|No MCP server|Unknown MCP server|Failed to install MCP server|Invalid|Marketplace .* not found/i;
    const results = new Map<string, unknown>();
    for (const tool of registry.list("cowork")) {
      if (["shell_job_status", "shell_job_result", "shell_job_clear"].includes(tool.name)) {
        if (!state.jobId) {
          const job = results.get("shell_exec_bg");
          state.jobId = id(job, /Started background job\s+([\w-]+)/i);
        }
      }
      if (["memory_read", "memory_delete"].includes(tool.name)) {
        const write = results.get("memory_write");
        state.memoryId = id(write, /id=([^\s]+)/);
      }
      if (["task_get", "task_update", "task_stop"].includes(tool.name)) {
        state.taskId = id(results.get("task_create"), /Created task\s+(task_[\w-]+)/i);
      }
      if (["schedule_run_now", "schedule_update", "schedule_delete"].includes(tool.name)) {
        state.scheduleId = id(results.get("schedule_create"), /Created task\s+"[^"]+"\s+\(([^)]+)\)/i);
      }
      if (["agent_status", "agent_cancel"].includes(tool.name) && !state.agentId) {
        const launch = await execute("agent_run", { description: "dependency agent", prompt: "return immediately", acceptance_criteria: ["Runner returns evidence"] });
        state.agentId = id(launch, /id:\s*(agent_[\w-]+)/i);
        results.set("agent_run", launch);
      }
      if (["plugin_disable", "plugin_enable", "plugin_uninstall"].includes(tool.name) && !state.pluginId) {
        const install = await execute("plugin_install", { source: join(root, "all-tools-plugin.zip") });
        state.pluginId = id(install, /ID:\s*([^\s]+)/i);
        results.set("plugin_install", install);
      }
      if (["file_edit", "file_edit_enhanced"].includes(tool.name)) {
        await writeFile(join(workspace, "generated.txt"), "generated by real tool smoke\n", "utf8");
      }
      if (tool.name === "file_copy") await writeFile(join(workspace, "seed.txt"), "seed content\n", "utf8");
      if (tool.name === "file_move") await writeFile(join(workspace, "seed-copy.txt"), "seed content\n", "utf8");
      if (tool.name === "file_delete") await writeFile(join(workspace, "seed-moved.txt"), "seed content\n", "utf8");
      if (tool.name === "directory_delete") await mkdir(join(workspace, "created-dir"), { recursive: true });
      if (["shell_job_status", "shell_job_result", "shell_job_clear"].includes(tool.name) && !state.jobId) {
        const launch = await execute("shell_exec_bg", { command: "printf 'dependency background\\n'", label: "dependency job" });
        state.jobId = id(launch, /Started background job\\s+([\\w-]+)/i);
        results.set("shell_exec_bg", launch);
      }
      if (tool.name === "shell_job_clear" && state.jobId) {
        await execute("shell_job_kill", { jobId: state.jobId, force: true });
      }
      if (["memory_read", "memory_delete"].includes(tool.name) && !state.memoryId) {
        const memoryResult = await execute("memory_write", { title: "dependency", type: "project", description: "dependency memory", body: "dependency body" });
        state.memoryId = id(memoryResult, /(?:id|memoryId)[=: ]+([^\\s]+)/i);
        results.set("memory_write", memoryResult);
      }
      if (["task_get", "task_update", "task_stop"].includes(tool.name) && !state.taskId) {
        const taskResult = await execute("task_create", { subject: "dependency task", description: "dependency task" });
        state.taskId = id(taskResult, /(task_[\\w-]+)/i);
        results.set("task_create", taskResult);
      }
      if (["schedule_run_now", "schedule_update", "schedule_delete"].includes(tool.name) && !state.scheduleId) {
        const scheduleResult = await execute("schedule_create", { name: "dependency schedule", prompt: "dependency", cron: "0 0 * * *" });
        state.scheduleId = id(scheduleResult, /\\(([^)]+)\\)/i);
        results.set("schedule_create", scheduleResult);
      }
      const result = await execute(tool.name, inputFor(tool.name));
      results.set(tool.name, result);
      if (result.ok) continue;
      const error = result.error ?? "";
      const supportedBoundary = expectedBoundary.test(error) || expectedExternal.test(error) || expectedContract.test(error);
      assert.ok(supportedBoundary, `${tool.name} failed unexpectedly: ${error}`);
    }

    assert.ok(state.jobId, "shell_exec_bg should return a real job id");
    assert.ok(state.memoryId, "memory_write should return a real note id");
    assert.ok(state.taskId, "task_create should return a real task id");
    assert.ok(state.scheduleId, "schedule_create should return a real schedule id");
    assert.ok(state.agentId, "agent_run should return a real agent id");
  });
});
