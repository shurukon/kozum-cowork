/**
 * Unit tests for the session store reducer.
 *
 * Tests the pure `applyEventToMode` logic — no React, no DOM, no zustand.
 * Every AgentEvent variant is exercised: text_delta accumulates, tool cards
 * update, turn_end finalises, error surfaces, task_update replaces the list,
 * and events for mode A never mutate mode B's state.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/unit/session-store.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyEventToMode,
  emptyModeState,
  type ModeState,
} from "../../src/renderer/store/sessionReducer.ts";

import type { AgentEvent, Mode, TokenUsage } from "../../src/shared/types.ts";

const COWORK: Mode = "cowork";

// ── Helpers ────────────────────────────────────────────────────────────────

const USAGE: TokenUsage = { inputTokens: 100, outputTokens: 50 };

function apply(state: ModeState, e: AgentEvent): ModeState {
  return applyEventToMode(state, e);
}

function fresh(): ModeState {
  return emptyModeState();
}

// ── Convenience: build states by chaining events ───────────────────────────

function withTurnStart(
  base = fresh(),
  sessionId = "s1",
  messageId = "m1",
  model = "claude-opus",
): ModeState {
  return apply(base, { type: "turn_start", mode: COWORK, sessionId, messageId, model });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("applyEventToMode — turn_start", () => {
  it("creates a new message shell with the correct id and role", () => {
    const s = withTurnStart();
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0]!.id, "m1");
    assert.equal(s.messages[0]!.role, "assistant");
    assert.equal(s.messages[0]!.model, "claude-opus");
    assert.equal(s.streamingMessageId, "m1");
  });

  it("clears any previous error", () => {
    let s = fresh();
    s = { ...s, error: "previous error" };
    s = withTurnStart(s);
    assert.equal(s.error, null);
  });

  it("resets streaming accumulators", () => {
    let s = fresh();
    s = { ...s, streamingText: "old", streamingThinking: "old" };
    s = withTurnStart(s);
    assert.equal(s.streamingText, "");
    assert.equal(s.streamingThinking, "");
  });

  it("clears the tool card map", () => {
    let s = fresh();
    s = apply(s, { type: "turn_start", mode: COWORK, sessionId: "s0", messageId: "prev", model: "m" });
    s = apply(s, {
      type: "tool_start",
      mode: COWORK,
      sessionId: "s0",
      toolUseId: "old-t",
      name: "bash",
      input: {},
    });
    assert.equal(s.toolCards.size, 1);
    s = withTurnStart(s, "s1", "m1");
    assert.equal(s.toolCards.size, 0);
  });
});

describe("applyEventToMode — text_delta", () => {
  it("accumulates deltas into streamingText", () => {
    let s = withTurnStart();
    s = apply(s, { type: "text_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: "Hello" });
    s = apply(s, { type: "text_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: " world" });
    assert.equal(s.streamingText, "Hello world");
  });

  it("updates the text block in the message's content", () => {
    let s = withTurnStart();
    s = apply(s, { type: "text_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: "Hi" });
    s = apply(s, { type: "text_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: "!" });

    const msg = s.messages.find((m) => m.id === "m1")!;
    const textBlock = msg.content.find((b) => b.type === "text");
    assert.ok(textBlock && textBlock.type === "text");
    assert.equal(textBlock.text, "Hi!");
  });

  it("ignores deltas for non-streaming messageId", () => {
    const s0 = withTurnStart();
    const s1 = apply(s0, {
      type: "text_delta",
      mode: COWORK,
      sessionId: "s1",
      messageId: "wrong-id",
      delta: "ignored",
    });
    assert.equal(s1.streamingText, "");
    assert.deepEqual(s1.messages, s0.messages);
  });
});

describe("applyEventToMode — thinking_delta", () => {
  it("accumulates deltas into streamingThinking", () => {
    let s = withTurnStart();
    s = apply(s, { type: "thinking_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: "Think" });
    s = apply(s, { type: "thinking_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: "ing..." });
    assert.equal(s.streamingThinking, "Thinking...");
  });

  it("creates a thinking block in the message content", () => {
    let s = withTurnStart();
    s = apply(s, { type: "thinking_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: "deep" });

    const msg = s.messages.find((m) => m.id === "m1")!;
    const block = msg.content.find((b) => b.type === "thinking");
    assert.ok(block && block.type === "thinking");
    assert.equal(block.text, "deep");
  });

  it("ignores thinking_delta for non-streaming messageId", () => {
    const s0 = withTurnStart();
    const s1 = apply(s0, {
      type: "thinking_delta",
      mode: COWORK,
      sessionId: "s1",
      messageId: "other",
      delta: "nope",
    });
    assert.equal(s1.streamingThinking, "");
  });
});

describe("applyEventToMode — tool_start / tool_progress / tool_end", () => {
  it("tool_start creates a running card", () => {
    let s = withTurnStart();
    s = apply(s, {
      type: "tool_start",
      mode: COWORK,
      sessionId: "s1",
      toolUseId: "t1",
      name: "bash",
      input: { command: "ls" },
    });

    assert.equal(s.toolCards.size, 1);
    const card = s.toolCards.get("t1")!;
    assert.equal(card.status, "running");
    assert.equal(card.name, "bash");
    assert.deepEqual(card.input, { command: "ls" });
  });

  it("tool_progress appends notes to the card", () => {
    let s = withTurnStart();
    s = apply(s, {
      type: "tool_start",
      mode: COWORK,
      sessionId: "s1",
      toolUseId: "t1",
      name: "bash",
      input: {},
    });
    s = apply(s, { type: "tool_progress", mode: COWORK, sessionId: "s1", toolUseId: "t1", note: "step 1" });
    s = apply(s, { type: "tool_progress", mode: COWORK, sessionId: "s1", toolUseId: "t1", note: "step 2" });

    const card = s.toolCards.get("t1")!;
    assert.deepEqual(card.notes, ["step 1", "step 2"]);
    assert.equal(card.status, "running");
  });

  it("tool_end marks card ok on success", () => {
    let s = withTurnStart();
    s = apply(s, {
      type: "tool_start",
      mode: COWORK,
      sessionId: "s1",
      toolUseId: "t1",
      name: "read_file",
      input: {},
    });
    s = apply(s, {
      type: "tool_end",
      mode: COWORK,
      sessionId: "s1",
      toolUseId: "t1",
      result: { ok: true, content: "file contents" },
    });

    const card = s.toolCards.get("t1")!;
    assert.equal(card.status, "ok");
    assert.ok(card.result);
    assert.equal(card.result.ok, true);
  });

  it("tool_end marks card error on failure", () => {
    let s = withTurnStart();
    s = apply(s, {
      type: "tool_start",
      mode: COWORK,
      sessionId: "s1",
      toolUseId: "t2",
      name: "shell",
      input: {},
    });
    s = apply(s, {
      type: "tool_end",
      mode: COWORK,
      sessionId: "s1",
      toolUseId: "t2",
      result: { ok: false, content: "", error: "EACCES" },
    });

    const card = s.toolCards.get("t2")!;
    assert.equal(card.status, "error");
    assert.equal(card.result?.error, "EACCES");
  });

  it("tool_progress ignores unknown toolUseId", () => {
    const s0 = withTurnStart();
    const s1 = apply(s0, {
      type: "tool_progress",
      mode: COWORK,
      sessionId: "s1",
      toolUseId: "ghost",
      note: "ignored",
    });
    // State unchanged.
    assert.equal(s1.toolCards.size, s0.toolCards.size);
  });
});

describe("applyEventToMode — turn_end", () => {
  it("clears streaming state and attaches usage + stopReason", () => {
    let s = withTurnStart();
    s = apply(s, { type: "text_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: "content" });
    s = apply(s, {
      type: "turn_end",
      mode: COWORK,
      sessionId: "s1",
      messageId: "m1",
      usage: USAGE,
      stopReason: "end_turn",
    });

    assert.equal(s.streamingMessageId, null);
    assert.equal(s.streamingText, "");
    assert.equal(s.streamingThinking, "");

    const msg = s.messages.find((m) => m.id === "m1")!;
    assert.deepEqual(msg.usage, USAGE);
    assert.equal(msg.stopReason, "end_turn");
  });

  it("preserves messages written before turn_end", () => {
    let s = withTurnStart();
    s = apply(s, { type: "text_delta", mode: COWORK, sessionId: "s1", messageId: "m1", delta: "kept" });
    s = apply(s, {
      type: "turn_end",
      mode: COWORK,
      sessionId: "s1",
      messageId: "m1",
      usage: USAGE,
      stopReason: "max_tokens",
    });

    const msg = s.messages.find((m) => m.id === "m1")!;
    const textBlock = msg.content.find((b) => b.type === "text");
    assert.ok(textBlock && textBlock.type === "text");
    assert.equal(textBlock.text, "kept");
  });
});

describe("applyEventToMode — error", () => {
  it("surfaces the error message and clears streaming", () => {
    let s = withTurnStart();
    s = apply(s, {
      type: "error",
      mode: COWORK,
      sessionId: "s1",
      message: "Rate limit exceeded",
      recoverable: true,
    });

    assert.equal(s.error, "Rate limit exceeded");
    assert.equal(s.streamingMessageId, null);
  });

  it("non-recoverable error also clears streaming", () => {
    let s = withTurnStart();
    s = apply(s, {
      type: "error",
      mode: COWORK,
      sessionId: "s1",
      message: "fatal",
      recoverable: false,
    });
    assert.equal(s.streamingMessageId, null);
    assert.equal(s.error, "fatal");
  });
});

describe("applyEventToMode — task_update", () => {
  it("replaces the task list entirely", () => {
    let s = fresh();
    s = apply(s, {
      type: "task_update",
      mode: COWORK,
      sessionId: "s1",
      tasks: [
        {
          id: "t1",
          subject: "first task",
          description: "",
          status: "pending",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    assert.equal(s.tasks.length, 1);
    assert.equal(s.tasks[0]!.subject, "first task");

    // Second update replaces.
    s = apply(s, {
      type: "task_update",
      mode: COWORK,
      sessionId: "s1",
      tasks: [
        {
          id: "t1",
          subject: "updated",
          description: "",
          status: "completed",
          createdAt: 0,
          updatedAt: 1,
        },
        {
          id: "t2",
          subject: "new task",
          description: "",
          status: "in_progress",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });

    assert.equal(s.tasks.length, 2);
    assert.equal(s.tasks[0]!.status, "completed");
    assert.equal(s.tasks[1]!.subject, "new task");
  });
});

describe("mode isolation", () => {
  it("events applied to mode A do not affect mode B's state", () => {
    let modeA = fresh();
    let modeB = fresh();

    // Apply a full turn to mode A only.
    modeA = apply(modeA, { type: "turn_start", mode: COWORK, sessionId: "sA", messageId: "mA1", model: "m" });
    modeA = apply(modeA, { type: "text_delta", mode: COWORK, sessionId: "sA", messageId: "mA1", delta: "A text" });
    modeA = apply(modeA, {
      type: "tool_start",
      mode: COWORK,
      sessionId: "sA",
      toolUseId: "tA",
      name: "bash",
      input: {},
    });
    modeA = apply(modeA, {
      type: "task_update",
      mode: COWORK,
      sessionId: "sA",
      tasks: [
        {
          id: "taskA",
          subject: "do A",
          description: "",
          status: "pending",
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    modeA = apply(modeA, {
      type: "turn_end",
      mode: COWORK,
      sessionId: "sA",
      messageId: "mA1",
      usage: USAGE,
      stopReason: "end_turn",
    });

    // Mode B must remain completely untouched.
    assert.equal(modeB.messages.length, 0, "mode B messages should be empty");
    assert.equal(modeB.streamingMessageId, null, "mode B streaming should be null");
    assert.equal(modeB.toolCards.size, 0, "mode B tool cards should be empty");
    assert.equal(modeB.tasks.length, 0, "mode B tasks should be empty");
    assert.equal(modeB.error, null, "mode B error should be null");
  });

  it("applying an error to mode A leaves mode B's messages intact", () => {
    let modeA = fresh();
    let modeB = fresh();

    // Give mode B a message.
    modeB = apply(modeB, {
      type: "turn_start",
      mode: COWORK,
      sessionId: "sB",
      messageId: "mB1",
      model: "m",
    });
    modeB = apply(modeB, {
      type: "text_delta",
      mode: COWORK,
      sessionId: "sB",
      messageId: "mB1",
      delta: "B content",
    });

    // Error on mode A.
    modeA = apply(modeA, {
      type: "error",
      mode: COWORK,
      sessionId: "sA",
      message: "A error",
      recoverable: false,
    });

    // Mode B is untouched.
    assert.equal(modeB.messages.length, 1);
    assert.equal(modeB.streamingText, "B content");
    assert.equal(modeB.error, null);

    // Mode A has the error.
    assert.equal(modeA.error, "A error");
  });
});
