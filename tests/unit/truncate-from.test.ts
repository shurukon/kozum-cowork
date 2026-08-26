/**
 * T7/T8 — SessionStore.truncateFrom
 *
 * In-place history truncation backing Regenerate/Edit:
 * - inclusive cut removes the anchor itself,
 * - exclusive cut keeps it (retry that preserves the question),
 * - counters (messageCount/totalUsage) follow the shortened transcript,
 * - missing session/anchor yields null without touching anything.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/main/session/store.ts";
import type { ModelSelection } from "../../src/shared/types.ts";

const selection: ModelSelection = { providerId: "anthropic", keyId: "k1", modelId: "claude-x" };

let root = "";
let store: SessionStore;
let sessionId = "";

function msg(id: string, role: "user" | "assistant", text: string) {
  return {
    id,
    role,
    content: [{ type: "text" as const, text }],
    createdAt: Date.now(),
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kozum-truncate-"));
  store = new SessionStore(root);
  const s = await store.create("cowork", selection);
  sessionId = s.id;
  await store.appendMessages(sessionId, [
    msg("m1", "user", "hello"),
    msg("a1", "assistant", "first answer"),
    msg("m2", "user", "second question"),
    msg("a2", "assistant", "second answer"),
  ]);
});

describe("SessionStore.truncateFrom", () => {
  it("inclusive cut removes the anchor and its tail", async () => {
    const res = await store.truncateFrom(sessionId, "a1", { inclusive: true });
    assert.ok(res && res.removed === 3);
    const left = await store.messages(sessionId);
    assert.deepEqual(left.map((m) => m.id), ["m1"]);
    const session = await store.get(sessionId);
    assert.equal(session?.messageCount, 1);
    assert.equal(session?.totalUsage.outputTokens, 5);
  });

  it("exclusive cut keeps the anchor (retry preserving the question)", async () => {
    const res = await store.truncateFrom(sessionId, "m2", { inclusive: false });
    assert.ok(res && res.removed === 1);
    const left = await store.messages(sessionId);
    assert.deepEqual(left.map((m) => m.id), ["m1", "a1", "m2"]);
  });

  it("returns null for unknown anchors without mutating storage", async () => {
    assert.equal(await store.truncateFrom(sessionId, "nope", { inclusive: true }), null);
    assert.equal(await store.truncateFrom("missing-session", "m1"), null);
    const all = await store.messages(sessionId);
    assert.equal(all.length, 4);
  });
});
