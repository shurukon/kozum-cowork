/**
 * Unit tests for the session reducer's pendingQuestions/pendingPermissions
 * handling and the store methods that resolve them.
 *
 * Covers P0-1 (ask_user_question inline UI) and P0-2 (permission_request
 * inline UI) backend→frontend wiring. Pure-logic only — no React, no DOM,
 * no zustand.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { applyEventToMode, emptyModeState } from "../../src/renderer/store/sessionReducer.ts";
import { useSessionStore } from "../../src/renderer/store/session.ts";
import type { ModeState, PendingQuestion, PendingPermission } from "../../src/renderer/store/sessionTypes.ts";
import type { AgentEvent } from "../../src/shared/types.ts";

// Reset the store between tests so each case starts from `emptyModeState()`.
beforeEach(() => {
  useSessionStore.setState({ cowork: emptyModeState(), code: emptyModeState() });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function startStreaming(state: ModeState, runId?: string): ModeState {
  return applyEventToMode(state, {
    type: "turn_start",
    mode: "cowork",
    sessionId: "s1",
    messageId: "msg_assistant",
    model: "m1",
    ...(runId ? { runId } : {}),
  });
}

function questionEvent(requestId: string, messageId?: string): AgentEvent {
  return {
    type: "question",
    mode: "cowork",
    sessionId: "s1",
    requestId,
    question: "Which platform?",
    options: [
      { label: "Web", value: "web" },
      { label: "iOS", value: "ios" },
    ],
    multiSelect: false,
    ...(messageId !== undefined ? { messageId } : {}),
  } as unknown as AgentEvent;
}

function permissionEvent(requestId: string, toolName = "file_write"): AgentEvent {
  return {
    type: "permission_request",
    mode: "cowork",
    sessionId: "s1",
    requestId,
    toolName,
    input: { path: "/tmp/a.txt" },
    reason: "Write a new file",
  };
}

function terminalSessionStatus(status: "idle" | "error" | "cancelled"): AgentEvent {
  return { type: "session_status", mode: "cowork", sessionId: "s1", status };
}

// ── Reducer behaviour ──────────────────────────────────────────────────────

describe("applyEventToMode — pending questions/permissions", () => {
  it("appends a question event to pendingQuestions and keeps prior entries", () => {
    let state = startStreaming(emptyModeState());
    state = applyEventToMode(state, questionEvent("q_1"));
    state = applyEventToMode(state, questionEvent("q_2"));

    assert.equal(state.pendingQuestions.length, 2);
    assert.equal(state.pendingQuestions[0].requestId, "q_1");
    assert.equal(state.pendingQuestions[1].requestId, "q_2");
  });

  it("appends a permission_request event to pendingPermissions", () => {
    let state = startStreaming(emptyModeState());
    state = applyEventToMode(state, permissionEvent("p_1"));

    assert.equal(state.pendingPermissions.length, 1);
    assert.equal(state.pendingPermissions[0].requestId, "p_1");
    assert.equal(state.pendingPermissions[0].toolName, "file_write");
  });

  it("anchors the pending entry to the currently streaming message", () => {
    let state = startStreaming(emptyModeState());
    state = applyEventToMode(state, questionEvent("q_1"));

    assert.equal(state.pendingQuestions[0].messageId, "msg_assistant");
  });

  it("clears both pending arrays when session_status transitions to idle", () => {
    let state = startStreaming(emptyModeState());
    state = applyEventToMode(state, questionEvent("q_1"));
    state = applyEventToMode(state, permissionEvent("p_1"));
    state = applyEventToMode(state, terminalSessionStatus("idle"));

    assert.equal(state.status, "idle");
    assert.equal(state.pendingQuestions.length, 0);
    assert.equal(state.pendingPermissions.length, 0);
  });

  it("clears pending arrays when an error event fires", () => {
    let state = startStreaming(emptyModeState());
    state = applyEventToMode(state, questionEvent("q_1"));
    state = applyEventToMode(state, {
      type: "error",
      mode: "cowork",
      sessionId: "s1",
      message: "boom",
      recoverable: false,
    });

    assert.equal(state.status, "error");
    assert.equal(state.pendingQuestions.length, 0);
  });
});

// ── Store methods ───────────────────────────────────────────────────────────

describe("applyEventToMode — stale run isolation", () => {
  it("records the active run id at turn_start", () => {
    const state = startStreaming(emptyModeState(), "run-new");
    assert.equal(state.currentRunId, "run-new");
  });

  it("ignores late text events from an older run", () => {
    let state = startStreaming(emptyModeState(), "run-old");
    state = applyEventToMode(state, {
      type: "text_delta",
      mode: "cowork",
      sessionId: "s1",
      runId: "run-old",
      messageId: "msg_assistant",
      delta: "old",
    });
    state = startStreaming(state, "run-new");
    state = applyEventToMode(state, {
      type: "text_delta",
      mode: "cowork",
      sessionId: "s1",
      runId: "run-old",
      messageId: "msg_assistant",
      delta: "late-old",
    });

    assert.equal(state.currentRunId, "run-new");
    assert.equal(state.streamingText, "");
  });

  it("ignores late tool events from an older run", () => {
    let state = startStreaming(emptyModeState(), "run-old");
    state = startStreaming(state, "run-new");
    state = applyEventToMode(state, {
      type: "tool_start",
      mode: "cowork",
      sessionId: "s1",
      runId: "run-old",
      toolUseId: "tool-old",
      name: "file_read",
      input: {},
    });

    assert.equal(state.toolCards.has("tool-old"), false);
  });
});

describe("applyEventToMode — task snapshot invariants", () => {
  it("deduplicates tasks by id and keeps the latest snapshot entry", () => {
    const duplicateTasks = [
      {
        id: "task-research",
        subject: "research",
        description: "Research the topic",
        status: "pending" as const,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "task-research",
        subject: "research",
        description: "Research the topic",
        status: "completed" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "task-plan",
        subject: "content plan",
        description: "Create a content plan",
        status: "in_progress" as const,
        createdAt: 3,
        updatedAt: 3,
      },
    ];

    const state = applyEventToMode(emptyModeState(), {
      type: "task_update",
      mode: "cowork",
      sessionId: "s1",
      tasks: duplicateTasks,
    });

    assert.deepEqual(
      state.tasks.map((task) => [task.id, task.status]),
      [
        ["task-research", "completed"],
        ["task-plan", "in_progress"],
      ],
    );
  });
});

describe("useSessionStore — resolveQuestion / resolvePermission", () => {
  it("resolveQuestion removes only the matching requestId", () => {
    useSessionStore.setState({
      cowork: {
        ...emptyModeState(),
        pendingQuestions: [
          { requestId: "q_1", question: "A", options: [], multiSelect: false },
          { requestId: "q_2", question: "B", options: [], multiSelect: false },
        ],
        pendingPermissions: [],
      } as ModeState,
      code: emptyModeState(),
    });

    useSessionStore.getState().resolveQuestion("cowork", "q_1");

    const remaining = useSessionStore.getState().cowork.pendingQuestions;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].requestId, "q_2");
  });

  it("resolvePermission removes only the matching requestId", () => {
    useSessionStore.setState({
      cowork: {
        ...emptyModeState(),
        pendingQuestions: [],
        pendingPermissions: [
          { requestId: "p_1", toolName: "file_write", input: {}, reason: "A" },
          { requestId: "p_2", toolName: "file_edit", input: {}, reason: "B" },
        ],
      } as ModeState,
      code: emptyModeState(),
    });

    useSessionStore.getState().resolvePermission("cowork", "p_2");

    const remaining = useSessionStore.getState().cowork.pendingPermissions;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].requestId, "p_1");
  });

  it("resolveQuestion is a no-op when the requestId is unknown", () => {
    const before = { ...emptyModeState() } as ModeState;
    useSessionStore.setState({ cowork: before, code: emptyModeState() });

    useSessionStore.getState().resolveQuestion("cowork", "does-not-exist");

    assert.equal(useSessionStore.getState().cowork.pendingQuestions.length, 0);
  });
});

// ── Type shape sanity ───────────────────────────────────────────────────────

describe("PendingQuestion / PendingPermission shapes", () => {
  it("PendingQuestion carries the four render-relevant fields", () => {
    const q: PendingQuestion = {
      requestId: "q",
      question: "Pick one",
      options: [{ label: "A", value: "a" }],
      multiSelect: true,
    };
    assert.equal(q.options.length, 1);
    assert.equal(q.multiSelect, true);
  });

  it("PendingPermission carries toolName + reason + input", () => {
    const p: PendingPermission = {
      requestId: "p",
      toolName: "file_write",
      input: { path: "/x" },
      reason: "writes a file",
    };
    assert.equal(p.toolName, "file_write");
    assert.equal(p.reason, "writes a file");
  });
});
