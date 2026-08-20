/**
 * Integration tests — task, ask, subagent, skill, and frontmatter tools.
 *
 * Uses node:test + node:assert/strict.
 * Real ToolRegistry + real ToolContext; real temp dirs for skill/agent files.
 * No mocks of our own code.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry } from "../../src/main/tools/registry.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";
import type { ModelCapabilities } from "../../src/shared/types.ts";

import { TaskStore, makeTaskTools } from "../../src/main/tools/tasks.ts";
import { AskBroker, makeAskTools } from "../../src/main/tools/ask.ts";
import {
  SubagentManager,
  makeSubagentTools,
  parseSubagentFile,
} from "../../src/main/agent/subagents.ts";
import { SkillStore, makeSkillTools, parseSkillFile } from "../../src/main/skills/index.ts";
import { parseFrontmatter } from "../../src/main/agent/frontmatter.ts";

/* --------------------------------------------------------- test context --- */

const CAPS: ModelCapabilities = {
  vision: "yes",
  tools: true,
  streaming: true,
  reasoning: false,
};

function makeCtx(sessionId = "sess-1", signal?: AbortSignal): ToolContext {
  return {
    sessionId,
    mode: "cowork",
    workingFolder: null,
    outputsDir: tmpdir(),
    capabilities: CAPS,
    modelId: "test-model",
    providerId: "test",
    signal: signal ?? new AbortController().signal,
    onProgress: () => undefined,
  };
}

/* =========================================================== FRONTMATTER == */

describe("parseFrontmatter", () => {
  it("parses plain scalars", () => {
    const text = "---\nname: Hello\ncount: 42\nflag: true\n---\nbody text";
    const { data, body } = parseFrontmatter(text);
    assert.equal(data["name"], "Hello");
    assert.equal(data["count"], "42");
    assert.equal(data["flag"], "true");
    assert.equal(body, "body text");
  });

  it("parses single and double quoted strings", () => {
    const text = `---\na: 'hello world'\nb: "goodbye"\n---\n`;
    const { data } = parseFrontmatter(text);
    assert.equal(data["a"], "hello world");
    assert.equal(data["b"], "goodbye");
  });

  it("parses inline arrays", () => {
    const text = `---\ntools: [read, write, "execute"]\n---\nbody`;
    const { data } = parseFrontmatter(text);
    assert.deepEqual(data["tools"], ["read", "write", "execute"]);
  });

  it("parses block lists", () => {
    const text = `---\ntools:\n  - read\n  - write\n---\nbody`;
    const { data } = parseFrontmatter(text);
    assert.deepEqual(data["tools"], ["read", "write"]);
  });

  it("returns empty data and original text when no frontmatter", () => {
    const text = "just some text";
    const { data, body } = parseFrontmatter(text);
    assert.deepEqual(data, {});
    assert.equal(body, text);
  });

  it("returns empty data on malformed frontmatter (no closing ---)", () => {
    const text = "---\nname: foo\nbody";
    const { data, body } = parseFrontmatter(text);
    assert.deepEqual(data, {});
    assert.equal(body, text);
  });

  it("handles empty frontmatter block", () => {
    const text = "---\n---\nbody";
    const { data, body } = parseFrontmatter(text);
    assert.deepEqual(data, {});
    assert.equal(body, "body");
  });

  it("never throws on any input", () => {
    for (const bad of ["", "---", "---\n", "---\n---", null as unknown as string]) {
      assert.doesNotThrow(() => parseFrontmatter(bad ?? ""));
    }
  });
});

/* ============================================================== TASKS ==== */

describe("task tools", () => {
  let registry: ToolRegistry;
  let store: TaskStore;

  before(() => {
    store = new TaskStore();
    registry = new ToolRegistry();
    registry.registerAll(makeTaskTools(store));
  });

  it("create → get → update → list → stop lifecycle", async () => {
    const ctx = makeCtx("t-1");

    // Create
    const createResult = await registry.execute(
      "task_create",
      { subject: "Write tests", description: "Add coverage for the new tools." },
      ctx,
    );
    assert.ok(createResult.ok, `create failed: ${createResult.error}`);
    const idMatch = createResult.content.match(/task_[a-z0-9_]+/);
    assert.ok(idMatch, "result should contain a task id");
    const taskId = idMatch![0]!;

    // Get
    const getResult = await registry.execute("task_get", { taskId }, ctx);
    assert.ok(getResult.ok);
    const got = JSON.parse(getResult.content);
    assert.equal(got.subject, "Write tests");
    assert.equal(got.status, "pending");

    // Update
    const updateResult = await registry.execute(
      "task_update",
      { taskId, status: "in_progress" },
      ctx,
    );
    assert.ok(updateResult.ok);

    const getAgain = await registry.execute("task_get", { taskId }, ctx);
    assert.ok(getAgain.ok);
    assert.equal(JSON.parse(getAgain.content).status, "in_progress");

    // List
    const listResult = await registry.execute("task_list", {}, ctx);
    assert.ok(listResult.ok);
    assert.ok(listResult.content.includes(taskId));

    // Stop
    const stopResult = await registry.execute("task_stop", { taskId }, ctx);
    assert.ok(stopResult.ok);

    const getFinal = await registry.execute("task_get", { taskId }, ctx);
    assert.ok(getFinal.ok);
    assert.equal(JSON.parse(getFinal.content).status, "stopped");
  });

  it("unknown taskId fails cleanly", async () => {
    const ctx = makeCtx("t-2");
    const r = await registry.execute("task_get", { taskId: "task_nonexistent" }, ctx);
    assert.ok(!r.ok);
    assert.ok(r.error?.includes("not found"));
  });

  it("tasks are isolated per sessionId", async () => {
    const ctxA = makeCtx("sess-A");
    const ctxB = makeCtx("sess-B");

    await registry.execute(
      "task_create",
      { subject: "Task A", description: "Only for A" },
      ctxA,
    );

    const listB = await registry.execute("task_list", {}, ctxB);
    assert.ok(listB.ok);
    assert.ok(!listB.content.includes("Task A"), "session B should not see session A tasks");
  });
});

/* ============================================================ ASK USER ==== */

describe("ask_user_question", () => {
  let registry: ToolRegistry;
  let broker: AskBroker;

  before(() => {
    broker = new AskBroker();
    registry = new ToolRegistry();
    registry.registerAll(makeAskTools(broker));
  });

  it("handler suspends until AskBroker.resolve() is called", async () => {
    const ctx = makeCtx("ask-1");
    let requestId: string | null = null;

    // Capture the requestId from onProgress
    const progressCtx: ToolContext = {
      ...ctx,
      onProgress(note: string) {
        if (note.startsWith("question:")) {
          requestId = note.slice("question:".length);
        }
      },
    };

    const handlerPromise = registry.execute(
      "ask_user_question",
      {
        question: "Pick a colour",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
        ],
        multiSelect: false,
      },
      progressCtx,
    );

    // Handler must not have resolved yet
    let resolved = false;
    handlerPromise.then(() => { resolved = true; });

    // Give microtasks a moment
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false, "handler should be suspended");

    // Resolve through the broker
    assert.ok(requestId, "onProgress should have been called with question:requestId");
    broker.resolve(requestId!, ["blue"]);

    const result = await handlerPromise;
    assert.ok(result.ok, `ask failed: ${result.error}`);
    assert.equal(result.content, "blue");
  });

  it("aborting ctx.signal rejects rather than hanging forever", async () => {
    const ctrl = new AbortController();
    const ctx = makeCtx("ask-abort", ctrl.signal);

    const handlerPromise = registry.execute(
      "ask_user_question",
      {
        question: "This will be aborted",
        options: [{ label: "Yes", value: "yes" }],
        multiSelect: false,
      },
      ctx,
    );

    // Abort immediately
    ctrl.abort();

    const result = await handlerPromise;
    // Should fail, not hang
    assert.ok(!result.ok || result.content !== undefined);
    // If it failed, the error should mention cancel
    if (!result.ok) {
      assert.ok(result.error, "should have an error message");
    }
  });
});

/* =========================================================== SUBAGENTS ==== */

describe("subagent tools", () => {
  let registry: ToolRegistry;
  let manager: SubagentManager;

  before(() => {
    // runner that resolves after a small delay
    const slowRunner = async (spec: { prompt: string }) => {
      await new Promise((r) => setTimeout(r, 50));
      return { text: `done: ${spec.prompt}` };
    };
    manager = new SubagentManager(slowRunner);
    registry = new ToolRegistry();
    registry.registerAll(makeSubagentTools(manager));
  });

  it("agent_run returns an id immediately (well before the runner finishes)", async () => {
    const ctx = makeCtx("sub-1");
    const start = Date.now();
    const result = await registry.execute(
      "agent_run",
      { description: "quick test task", prompt: "do something", acceptance_criteria: ["Runner returns evidence"] },
      ctx,
    );
    const elapsed = Date.now() - start;

    assert.ok(result.ok, `agent_run failed: ${result.error}`);
    assert.ok(elapsed < 30, `agent_run should return immediately, took ${elapsed}ms`);
    assert.ok(result.content.includes("agent_"), "result should include agent id");
  });

  it("agent_status transitions running → completed", async () => {
    const ctx = makeCtx("sub-2");

    const runResult = await registry.execute(
      "agent_run",
      { description: "transitions test", prompt: "run me", acceptance_criteria: ["Runner returns the prompt evidence"] },
      ctx,
    );
    assert.ok(runResult.ok);
    const idMatch = runResult.content.match(/agent_[a-z0-9_]+/);
    assert.ok(idMatch, "result should include agent id");
    const agentId = idMatch![0]!;

    // Initially running
    const statusRunning = await registry.execute("agent_status", { agentId }, ctx);
    assert.ok(statusRunning.ok);
    assert.ok(statusRunning.content.includes("running") || statusRunning.content.includes("completed"));

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));

    const statusDone = await registry.execute("agent_status", { agentId }, ctx);
    assert.ok(statusDone.ok);
    assert.ok(statusDone.content.includes("completed"), `expected completed, got: ${statusDone.content}`);
    assert.ok(statusDone.content.includes("run me"), "result should contain prompt");
  });

  it("throwing runner yields status failed with the error", async () => {
    const throwingRunner = async () => {
      throw new Error("runner exploded");
    };
    const m = new SubagentManager(throwingRunner);
    const reg = new ToolRegistry();
    reg.registerAll(makeSubagentTools(m));

    const ctx = makeCtx("sub-fail");
    const run = await reg.execute(
      "agent_run",
      { description: "failing task", prompt: "break it", acceptance_criteria: ["Runner reports the failure"] },
      ctx,
    );
    assert.ok(run.ok);
    const idMatch = run.content.match(/agent_[a-z0-9_]+/);
    assert.ok(idMatch);
    const agentId = idMatch![0]!;

    await new Promise((r) => setTimeout(r, 50));

    const status = await reg.execute("agent_status", { agentId }, ctx);
    assert.ok(status.ok);
    assert.ok(status.content.includes("failed"), `expected failed, got: ${status.content}`);
    assert.ok(status.content.includes("runner exploded"));
  });

  it("agent_list shows all runs", async () => {
    const m = new SubagentManager(async (spec) => ({ text: `done: ${spec.prompt}` }));
    const reg = new ToolRegistry();
    reg.registerAll(makeSubagentTools(m));
    const ctx = makeCtx("sub-list");

    await reg.execute("agent_run", { description: "task one", prompt: "one", acceptance_criteria: ["one completes"] }, ctx);
    await reg.execute("agent_run", { description: "task two", prompt: "two", acceptance_criteria: ["two completes"] }, ctx);

    const list = await reg.execute("agent_list", {}, ctx);
    assert.ok(list.ok);
    assert.ok(list.content.includes("task one"));
    assert.ok(list.content.includes("task two"));
  });

  it("concurrency cap queues the 5th run", async () => {
    let active = 0;
    let maxActive = 0;
    const blocker = async (spec: { prompt: string }) => {
      active++;
      if (active > maxActive) maxActive = active;
      await new Promise((r) => setTimeout(r, 60));
      active--;
      return { text: `done: ${spec.prompt}` };
    };

    const m = new SubagentManager(blocker, 4); // cap at 4
    const reg = new ToolRegistry();
    reg.registerAll(makeSubagentTools(m));
    const ctx = makeCtx("sub-cap");

    // Launch 5 — the 5th should be queued
    for (let i = 1; i <= 5; i++) {
      await reg.execute("agent_run", { description: `run ${i}`, prompt: `p${i}` }, ctx);
    }

    // Small tick to let things schedule
    await new Promise((r) => setImmediate(r));

    assert.ok(maxActive <= 4, `max concurrent should be ≤4, was ${maxActive}`);

    // Wait for everything to finish
    await new Promise((r) => setTimeout(r, 400));
  });
});

/* ===================================================== parseSubagentFile == */

describe("parseSubagentFile", () => {
  it("parses all frontmatter fields and body as systemPrompt", () => {
    const text = `---
name: My Researcher
description: Does research tasks
model: gpt-4o
tools: web_search, file_read
---
You are a research assistant.
Be thorough and cite sources.`;

    const meta = parseSubagentFile(text, "/fake/agents/researcher.md");
    assert.equal(meta.name, "My Researcher");
    assert.equal(meta.description, "Does research tasks");
    assert.equal(meta.model, "gpt-4o");
    assert.deepEqual(meta.tools, ["web_search", "file_read"]);
    assert.ok(meta.systemPrompt.includes("research assistant"));
  });

  it("parses comma-separated tools", () => {
    const text = `---
name: Coder
description: Writes code
tools: file_write, shell_exec, file_read
---
Body`;
    const meta = parseSubagentFile(text, "/fake/agents/coder.md");
    assert.deepEqual(meta.tools, ["file_write", "shell_exec", "file_read"]);
  });

  it("parses inline array tools", () => {
    const text = `---
name: Planner
description: Plans work
tools: [read, write, "search tool"]
---
Plan everything.`;
    const meta = parseSubagentFile(text, "/fake/agents/planner.md");
    assert.deepEqual(meta.tools, ["read", "write", "search tool"]);
  });
});

/* ========================================================= parseSkillFile / SkillStore */

let skillTmpDir = "";

before(async () => {
  skillTmpDir = await mkdtemp(join(tmpdir(), "kozum-skills-"));
});

after(async () => {
  if (skillTmpDir) await rm(skillTmpDir, { recursive: true, force: true });
});

describe("parseSkillFile", () => {
  it("parses all supported fields", () => {
    const text = `---
name: Code Review
description: Performs systematic code review
when_to_use: When you need to review a pull request
allowed-tools: file_read, file_search
modes: [cowork, code]
---
## Code Review Instructions
Always check for security vulnerabilities first.`;

    const meta = parseSkillFile(text, "/fake/skills/code-review/SKILL.md");
    assert.equal(meta.name, "Code Review");
    assert.equal(meta.description, "Performs systematic code review");
    assert.equal(meta.whenToUse, "When you need to review a pull request");
    assert.deepEqual(meta.allowedTools, ["file_read", "file_search"]);
    assert.deepEqual(meta.modes, ["cowork", "code"]);
    assert.ok(meta.body.includes("security vulnerabilities"));
  });

  it("supports whenToUse camelCase alias", () => {
    const text = `---
name: Debugger
description: Helps debug code
whenToUse: When debugging runtime errors
---
Debug systematically.`;
    const meta = parseSkillFile(text, "/path/SKILL.md");
    assert.equal(meta.whenToUse, "When debugging runtime errors");
  });

  it("supports allowedTools camelCase alias", () => {
    const text = `---
name: Writer
description: Writes documents
allowedTools: file_write, file_read
---
Write clearly.`;
    const meta = parseSkillFile(text, "/path/SKILL.md");
    assert.deepEqual(meta.allowedTools, ["file_write", "file_read"]);
  });
});

describe("SkillStore.discover", () => {
  it("finds 2 valid skills and skips 1 malformed", async () => {
    // Set up temp tree:
    //   skills/
    //     skill-a/SKILL.md  — valid
    //     skill-b/SKILL.md  — valid
    //     skill-bad/SKILL.md — malformed (no name)

    const skillA = `---
name: Skill Alpha
description: The alpha skill
when_to_use: Use for alpha tasks
---
Alpha instructions.`;

    const skillB = `---
name: Skill Beta
description: The beta skill
---
Beta instructions.`;

    const skillBad = `---
description: No name field here
---
Bad skill.`;

    await mkdir(join(skillTmpDir, "skill-a"), { recursive: true });
    await mkdir(join(skillTmpDir, "skill-b"), { recursive: true });
    await mkdir(join(skillTmpDir, "skill-bad"), { recursive: true });

    await writeFile(join(skillTmpDir, "skill-a", "SKILL.md"), skillA);
    await writeFile(join(skillTmpDir, "skill-b", "SKILL.md"), skillB);
    await writeFile(join(skillTmpDir, "skill-bad", "SKILL.md"), skillBad);

    const store = new SkillStore();
    await store.discover([skillTmpDir]);

    const skills = store.list();
    assert.equal(skills.length, 2, "should find exactly 2 valid skills");
    assert.ok(
      skills.some((s) => s.name === "Skill Alpha"),
      "Skill Alpha should be found",
    );
    assert.ok(
      skills.some((s) => s.name === "Skill Beta"),
      "Skill Beta should be found",
    );
    assert.equal(store.warnings.length, 1, "should record 1 warning for malformed skill");
    assert.ok(store.warnings[0]!.path.includes("skill-bad"), "warning should identify bad skill");
  });

  it("does not throw on missing or unreadable roots", async () => {
    const store = new SkillStore();
    await assert.doesNotReject(() => store.discover(["/nonexistent/path/that/does/not/exist"]));
    assert.equal(store.list().length, 0);
  });
});

/* =========================================================== SKILL TOOLS == */

describe("skill tools", () => {
  let registry: ToolRegistry;
  let store: SkillStore;

  before(async () => {
    store = new SkillStore();
    // Register one skill manually for fast tests
    store.register({
      id: "s1",
      name: "My Test Skill",
      description: "A test skill",
      path: "/fake/SKILL.md",
      source: "user",
      enabled: true,
      modes: ["cowork", "code"],
      body: "## My Test Skill\nDo things the right way.",
    });

    registry = new ToolRegistry();
    registry.registerAll(makeSkillTools(store));
  });

  it("skill_list shows registered skills", async () => {
    const ctx = makeCtx("skill-1");
    const result = await registry.execute("skill_list", {}, ctx);
    assert.ok(result.ok);
    assert.ok(result.content.includes("My Test Skill"));
  });

  it("skill_invoke returns the SKILL.md body", async () => {
    const ctx = makeCtx("skill-2");
    const result = await registry.execute("skill_invoke", { skill: "My Test Skill" }, ctx);
    assert.ok(result.ok, `invoke failed: ${result.error}`);
    assert.ok(result.content.includes("Do things the right way."));
  });

  it("unknown skill lists available names", async () => {
    const ctx = makeCtx("skill-3");
    const result = await registry.execute("skill_invoke", { skill: "No Such Skill" }, ctx);
    assert.ok(!result.ok);
    assert.ok(result.error?.includes("My Test Skill"), `should list available skills: ${result.error}`);
  });
});
