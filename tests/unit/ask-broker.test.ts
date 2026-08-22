/**
 * Unit tests for AskBroker — specifically the new registerPending path that
 * the per-tool permission flow uses to pre-allocate a requestId matching the
 * one emitted to the UI (P0-2 fix in src/main/session/manager.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AskBroker } from "../../src/main/tools/ask.ts";

const PAYLOAD = {
  question: "Allow this tool to run?",
  options: [
    { label: "Allow", value: "yes" },
    { label: "Deny", value: "no" },
  ],
  multiSelect: false,
};

describe("AskBroker.registerPending", () => {
  it("round-trips a value when resolve(requestId, values) is called", async () => {
    const broker = new AskBroker();
    const promise = broker.registerPending("perm_42", PAYLOAD);

    const ok = broker.resolve("perm_42", ["yes"]);
    assert.equal(ok, true);
    assert.deepEqual(await promise, ["yes"]);
  });

  it("preserves the pre-allocated requestId (does not generate a new one)", () => {
    const broker = new AskBroker();
    const before = broker as unknown as { pending: Map<string, unknown> };
    broker.registerPending("perm_fixed", PAYLOAD);
    assert.ok(before.pending.has("perm_fixed"));
    assert.equal(before.pending.size, 1);
  });

  it("rejects cleanly when reject(requestId, reason) is called", async () => {
    const broker = new AskBroker();
    const promise = broker.registerPending("perm_99", PAYLOAD);

    const ok = broker.reject("perm_99", "Cancelled by abort signal.");
    assert.equal(ok, true);
    await assert.rejects(promise, /Cancelled by abort signal/);
  });

  it("returns false for resolve() against an unknown requestId", () => {
    const broker = new AskBroker();
    assert.equal(broker.resolve("nope", ["yes"]), false);
  });

  it("clears the entry on resolve so a second resolve is a no-op", () => {
    const broker = new AskBroker();
    broker.registerPending("perm_7", PAYLOAD);
    assert.equal(broker.resolve("perm_7", ["yes"]), true);
    assert.equal(broker.resolve("perm_7", ["no"]), false);
  });

  it("ask() path still works independently", () => {
    const broker = new AskBroker();
    const { requestId, promise } = broker.ask("session_1", PAYLOAD);
    assert.ok(requestId.startsWith("ask_"));
    broker.resolve(requestId, ["yes"]);
    return promise.then((v) => assert.deepEqual(v, ["yes"]));
  });

  it("rejectAllForSession only tears down requests owned by that session", async () => {
    const broker = new AskBroker();
    const deletedPromise = broker.registerPending("perm_deleted", PAYLOAD, "session_deleted");
    const activePromise = broker.registerPending("perm_active", PAYLOAD, "session_active");

    broker.rejectAllForSession("session_deleted", "Session was deleted.");
    assert.equal(broker.resolve("perm_deleted", ["yes"]), false);
    assert.equal(broker.resolve("perm_active", ["yes"]), true);

    await assert.rejects(deletedPromise, /Session was deleted/);
    assert.deepEqual(await activePromise, ["yes"]);
  });

  it("rejects a reply carrying the wrong sessionId", async () => {
    const broker = new AskBroker();
    const promise = broker.registerPending("perm_scoped", PAYLOAD, "session_owner");

    assert.equal(broker.resolve("perm_scoped", ["yes"], "session_other"), false);
    assert.equal(broker.resolve("perm_scoped", ["yes"], "session_owner"), true);
    assert.deepEqual(await promise, ["yes"]);
  });
});
