/**
 * Unit tests for SubagentManager.setRunner — verifies the deferred-construction
 * pattern used by src/main/index.ts: the manager is created with a stub
 * runner, then setRunner() swaps in the real runner once the provider
 * registry is available. P0-6.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SubagentManager, makeSubagentTools } from "../../src/main/agent/subagents.ts";
import { TaskStore } from "../../src/main/tools/tasks.ts";

describe("SubagentManager.setRunner", () => {
  it("uses the stub runner initially until setRunner is called", async () => {
    let stubCalled = 0;
    const mgr = new SubagentManager(async () => {
      stubCalled++;
      return { text: "stub" };
    });

    const id = mgr.launch("parent", "test", "test desc", "", "do thing");
    // Wait for the run to settle.
    await waitForStatus(mgr, id, "completed");

    const run = mgr.getStatus(id);
    assert.equal(stubCalled, 1);
    assert.equal(run?.result, "stub");
  });

  it("setRunner replaces the runner for subsequent launches", async () => {
    const mgr = new SubagentManager(async () => ({ text: "STUB" }));

    let realCalled = 0;
    mgr.setRunner(async () => {
      realCalled++;
      return { text: "REAL" };
    });

    const id = mgr.launch("parent", "real", "real desc", "", "do thing");
    await waitForStatus(mgr, id, "completed");

    const run = mgr.getStatus(id);
    assert.equal(realCalled, 1);
    assert.equal(run?.result, "REAL");
  });

  it("marks a run failed when the runner throws", async () => {
    const mgr = new SubagentManager(async () => {
      throw new Error("provider offline");
    });

    const id = mgr.launch("parent", "boom", "boom desc", "", "do thing");
    await waitForStatus(mgr, id, "failed");

    const run = mgr.getStatus(id);
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /provider offline/);
  });

  it("listAll tracks every launched run", async () => {
    const mgr = new SubagentManager(async () => ({ text: "ok" }));
    const a = mgr.launch("p", "a", "a", "", "p");
    const b = mgr.launch("p", "b", "b", "", "p");
    await waitForStatus(mgr, a, "completed");
    await waitForStatus(mgr, b, "completed");
    const all = mgr.listAll();
    assert.ok(all.some((r) => r.id === a));
    assert.ok(all.some((r) => r.id === b));
  });

  it("tracks acceptance criteria and a child task through completion", async () => {
    const tasks = new TaskStore();
    let receivedCriteria: string[] | undefined;
    let receivedTaskId: string | undefined;
    const mgr = new SubagentManager(async (spec) => {
      receivedCriteria = spec.acceptanceCriteria;
      receivedTaskId = spec.taskId;
      return { text: "Evidence: real check passed." };
    }, 1, tasks);

    const id = mgr.launch(
      "parent-code",
      "verify build",
      "Verify the build",
      "",
      "Run the build and report evidence.",
      undefined,
      undefined,
      undefined,
      "code",
      ["Build exits with code 0", "Report the command output"],
    );
    await waitForStatus(mgr, id, "completed");

    const run = mgr.getStatus(id);
    assert.deepEqual(receivedCriteria, ["Build exits with code 0", "Report the command output"]);
    assert.equal(receivedTaskId, run?.taskId);
    assert.equal(run?.acceptanceCriteria?.length, 2);
    assert.equal(tasks.list("parent-code").length, 1);
    assert.equal(tasks.list("parent-code")[0]?.status, "completed");
    assert.equal(tasks.modeFor("parent-code"), "code");
  });

  it("rejects agent_status access across sessions and modes", async () => {
    const mgr = new SubagentManager(async () => ({ text: "done" }));
    const id = mgr.launch("owner", "private", "private", "", "do", undefined, undefined, undefined, "code", ["done"]);
    await waitForStatus(mgr, id, "completed");
    const statusTool = makeSubagentTools(mgr).find((tool) => tool.definition.name === "agent_status");
    assert.ok(statusTool);
    const result = await statusTool.handler(
      { agentId: id },
      {
        sessionId: "other",
        mode: "cowork",
        workingFolder: null,
        outputsDir: process.cwd(),
        capabilities: { vision: "unknown", tools: true, streaming: true, reasoning: false },
        modelId: "test",
        providerId: "test",
        signal: new AbortController().signal,
        onProgress: () => undefined,
      },
    );
    assert.equal(result.ok, false);
  });

  it("emits one terminal event when cancellation is followed by runner rejection", async () => {
    const terminal: string[] = [];
    const mgr = new SubagentManager(async ({ signal }) => {
      await new Promise<void>((_, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { text: "unreachable" };
    });
    mgr.setEmitter((_sessionId, event) => {
      if (event.type === "subagent_end") terminal.push(event.status);
    });

    const id = mgr.launch("p", "cancel", "cancel", "", "p");
    assert.equal(mgr.cancel(id), true);
    await waitForStatus(mgr, id, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(terminal, ["cancelled"]);
    assert.equal(mgr.cancel(id), false);
  });
});

function waitForStatus(
  mgr: SubagentManager,
  id: string,
  status: "running" | "completed" | "failed" | "cancelled",
): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      const r = mgr.getStatus(id);
      if (r && r.status === status) return resolve();
      setTimeout(tick, 5);
    };
    tick();
  });
}
