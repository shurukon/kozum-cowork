/**
 * Unit tests for SubagentManager.setRunner — verifies the deferred-construction
 * pattern used by src/main/index.ts: the manager is created with a stub
 * runner, then setRunner() swaps in the real runner once the provider
 * registry is available. P0-6.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SubagentManager } from "../../src/main/agent/subagents.ts";

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
