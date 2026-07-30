/**
 * Integration tests for Session Store new operations:
 * - delete (hard-remove)
 * - branch (fork)
 * - rename
 * - setPermissionMode
 * - default folder resolution
 *
 * Uses real temporary directories, no mocking.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/main/session/store.ts";

/* ------------------------------------------------------------------ setup */

let tmpDir: string;
let store: SessionStore;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kozum-session-ops-"));
  store = new SessionStore(tmpDir);
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const SELECTION = { providerId: "anthropic", keyId: "key1", modelId: "claude-opus-4-6" };

/* ================================================================ delete == */

describe("SessionStore.delete", () => {
  it("returns false for a non-existent session", async () => {
    const result = await store.delete("nonexistent-id");
    assert.equal(result, false);
  });

  it("hard-deletes an existing session so get returns null afterwards", async () => {
    const session = await store.create("cowork", SELECTION);
    const result = await store.delete(session.id);
    assert.equal(result, true);

    const retrieved = await store.get(session.id);
    assert.equal(retrieved, null);
  });

  it("also removes messages: messages() returns [] after delete", async () => {
    const session = await store.create("code", SELECTION);
    await store.appendMessages(session.id, [
      {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: Date.now(),
      },
    ]);
    await store.delete(session.id);
    const msgs = await store.messages(session.id);
    assert.equal(msgs.length, 0);
  });
});

/* ================================================================ branch == */

describe("SessionStore.branch", () => {
  it("returns null for a non-existent session", async () => {
    const result = await store.branch("nonexistent");
    assert.equal(result, null);
  });

  it("creates a new session with a different id", async () => {
    const src = await store.create("cowork", SELECTION);
    const branch = await store.branch(src.id);
    assert.ok(branch);
    assert.notEqual(branch.id, src.id);
  });

  it("copies the source session's mode and selection", async () => {
    const src = await store.create("code", SELECTION);
    const branch = await store.branch(src.id);
    assert.ok(branch);
    assert.equal(branch.mode, "code");
    assert.deepEqual(branch.selection, SELECTION);
  });

  it("copies all messages when uptoMessageId is omitted", async () => {
    const src = await store.create("cowork", SELECTION);
    const messages = [
      { id: "m1", role: "user" as const, content: [{ type: "text" as const, text: "first" }], createdAt: 1 },
      { id: "m2", role: "assistant" as const, content: [{ type: "text" as const, text: "second" }], createdAt: 2 },
    ];
    await store.appendMessages(src.id, messages);

    const branch = await store.branch(src.id);
    assert.ok(branch);
    const branchMsgs = await store.messages(branch.id);
    assert.equal(branchMsgs.length, 2);
    assert.equal(branchMsgs[0]!.id, "m1");
    assert.equal(branchMsgs[1]!.id, "m2");
  });

  it("copies only messages up to uptoMessageId (inclusive)", async () => {
    const src = await store.create("cowork", SELECTION);
    const messages = [
      { id: "msg-a", role: "user" as const, content: [{ type: "text" as const, text: "A" }], createdAt: 1 },
      { id: "msg-b", role: "assistant" as const, content: [{ type: "text" as const, text: "B" }], createdAt: 2 },
      { id: "msg-c", role: "user" as const, content: [{ type: "text" as const, text: "C" }], createdAt: 3 },
    ];
    await store.appendMessages(src.id, messages);

    const branch = await store.branch(src.id, "msg-b");
    assert.ok(branch);
    const branchMsgs = await store.messages(branch.id);
    assert.equal(branchMsgs.length, 2, "should include msg-a and msg-b only");
    assert.equal(branchMsgs[0]!.id, "msg-a");
    assert.equal(branchMsgs[1]!.id, "msg-b");
  });

  it("editing branch messages does not touch original", async () => {
    const src = await store.create("cowork", SELECTION);
    await store.appendMessages(src.id, [
      { id: "orig-1", role: "user" as const, content: [{ type: "text" as const, text: "original" }], createdAt: 1 },
    ]);

    const branch = await store.branch(src.id);
    assert.ok(branch);

    // Append to branch only
    await store.appendMessages(branch.id, [
      { id: "branch-2", role: "assistant" as const, content: [{ type: "text" as const, text: "branch msg" }], createdAt: 2 },
    ]);

    const origMsgs = await store.messages(src.id);
    assert.equal(origMsgs.length, 1, "original should still have 1 message");
    const branchMsgs = await store.messages(branch.id);
    assert.equal(branchMsgs.length, 2, "branch should have 2 messages");
  });

  it("branch title appends (branch) when source has a real title", async () => {
    const src = await store.create("cowork", SELECTION);
    // Give it a real title by appending a user message
    await store.appendMessages(src.id, [
      { id: "t1", role: "user" as const, content: [{ type: "text" as const, text: "Help me write a report" }], createdAt: 1 },
    ]);
    const srcSession = await store.get(src.id);
    assert.ok(srcSession && srcSession.title !== "New session");

    const branch = await store.branch(src.id);
    assert.ok(branch);
    assert.ok(branch.title.includes("branch"), `branch title should mention 'branch', got: ${branch.title}`);
  });
});

/* ================================================================ rename == */

describe("SessionStore.rename", () => {
  it("returns false for a non-existent session", async () => {
    const result = await store.rename("nonexistent", "New Title");
    assert.equal(result, false);
  });

  it("updates the title and updatedAt", async () => {
    const session = await store.create("cowork", SELECTION);
    const before = session.updatedAt;

    // Small delay to ensure timestamp changes
    await new Promise<void>((r) => setTimeout(r, 5));
    const result = await store.rename(session.id, "My renamed session");
    assert.equal(result, true);

    const updated = await store.get(session.id);
    assert.ok(updated);
    assert.equal(updated.title, "My renamed session");
    assert.ok(updated.updatedAt > before, "updatedAt should increase");
  });
});

/* ============================================================== setPermissionMode == */

describe("SessionStore.setPermissionMode", () => {
  it("returns false for a non-existent session", async () => {
    const result = await store.setPermissionMode("nonexistent", "plan");
    assert.equal(result, false);
  });

  it("updates permissionMode on disk", async () => {
    const session = await store.create("code", SELECTION);
    assert.equal(session.permissionMode, "manual"); // default

    const result = await store.setPermissionMode(session.id, "bypass_permissions");
    assert.equal(result, true);

    const updated = await store.get(session.id);
    assert.ok(updated);
    assert.equal(updated.permissionMode, "bypass_permissions");
  });

  for (const mode of ["manual", "accept_edits", "plan", "bypass_permissions"] as const) {
    it(`persists mode: ${mode}`, async () => {
      const session = await store.create("cowork", SELECTION);
      await store.setPermissionMode(session.id, mode);
      const updated = await store.get(session.id);
      assert.equal(updated?.permissionMode, mode);
    });
  }
});
