/**
 * Unit tests for PermissionQueue — the per-session prompt serialization
 * introduced with the Ask/Permission Dock (Task 1).
 *
 * Contract: enqueued tasks start strictly one-at-a-time per session, in FIFO
 * order, regardless of how many callers race; a rejected/failed task never
 * blocks the next one; different sessions never block each other.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionQueue } from "../../src/main/session/permissions-queue.ts";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PermissionQueue serialization", () => {
  it("runs 3 concurrent gated calls strictly one-at-a-time", async () => {
    const queue = new PermissionQueue();
    const events: string[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const results = gates.map((gate, i) =>
      queue.run("session-a", async () => {
        events.push(`start-${i}`);
        await gate.promise;
        events.push(`end-${i}`);
        return i;
      }),
    );

    // Give microtasks a chance to (incorrectly) start everything.
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, ["start-0"], "only the first task may start initially");

    gates[0]!.resolve();
    assert.equal(await results[0], 0);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(
      events.slice(0, 3),
      ["start-0", "end-0", "start-1"],
      "the second task starts only after the first fully settled",
    );

    gates[1]!.resolve();
    await new Promise((r) => setTimeout(r, 10));
    gates[2]!.resolve();
    // Settle every task before inspecting the event order.
    assert.deepEqual(await Promise.all(results), [0, 1, 2]);

    assert.deepEqual(
      events,
      ["start-0", "end-0", "start-1", "end-1", "start-2", "end-2"],
      "events must be emitted strictly one-at-a-time",
    );
  });

  it("a rejected task does not block the next queued prompt", async () => {
    const queue = new PermissionQueue();
    const events: string[] = [];

    const first = queue.run("session-a", async () => {
      events.push("first");
      throw new Error("denied by user");
    });
    const second = queue.run("session-a", async () => {
      events.push("second");
      return "ok";
    });

    await assert.rejects(() => first, /denied by user/);
    assert.equal(await second, "ok");
    assert.deepEqual(events, ["first", "second"]);
  });

  it("does not serialize different sessions", async () => {
    const queue = new PermissionQueue();
    const gateA = deferred();
    const started: string[] = [];

    const a = queue.run("session-a", async () => {
      started.push("a");
      await gateA.promise;
    });
    const b = queue.run("session-b", async () => {
      started.push("b");
    });

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(started.includes("b"), "session-b must start while session-a waits");

    gateA.resolve();
    await a;
    await b;
  });

  it("cleans up idle sessions so the map cannot grow unbounded", async () => {
    const queue = new PermissionQueue();
    await queue.run("one-shot", async () => undefined);
    // Let the finally-hook microtask run.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(queue.activeSessionCount, 0);
  });
});
