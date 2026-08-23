/**
 * Regression tests for the permission/question anchoring fix.
 *
 * Root cause of the Windows 120s tool-timeout family: the reducer anchored
 * pending prompts to `streamingMessageId ?? undefined`, which is null whenever
 * a tool runs after its turn's text completed (providers emit turn_end before
 * the separate tool_start). The banner then matched nothing, never rendered,
 * and AskBroker pended until the tool timed out. These tests pin the new
 * behaviour: prompts always carry a toolUseId when one is known and a
 * messageId that exists in the transcript.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyEventToMode, emptyModeState } from "../../src/renderer/store/sessionReducer.ts";
import {
  anchorPendingItems,
  selectStranded,
  collectStrandedPrompts,
} from "../../src/renderer/lib/pendingAnchor.ts";
import type { ModeState } from "../../src/renderer/store/sessionTypes.ts";
import type { AgentEvent } from "../../src/shared/types.ts";

// ── Event builders ─────────────────────────────────────────────────────────

function turnStart(state: ModeState, messageId = "msg_assistant"): ModeState {
  return applyEventToMode(state, {
    type: "turn_start",
    mode: "cowork",
    sessionId: "s1",
    messageId,
    model: "m1",
  });
}

/** Providers emit turn_end(stopReason=tool_use) BEFORE the separate tool_start. */
function turnEndForToolUse(state: ModeState, messageId = "msg_assistant"): ModeState {
  return applyEventToMode(state, {
    type: "turn_end",
    mode: "cowork",
    sessionId: "s1",
    messageId,
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  });
}

function toolStart(state: ModeState, toolUseId: string, name = "shell_exec"): ModeState {
  return applyEventToMode(state, {
    type: "tool_start",
    mode: "cowork",
    sessionId: "s1",
    toolUseId,
    name,
    input: {},
  });
}

function permissionRequest(requestId: string): AgentEvent {
  return {
    type: "permission_request",
    mode: "cowork",
    sessionId: "s1",
    requestId,
    toolName: "shell_exec",
    input: { command: "echo hi" },
    reason: 'Run "echo hi"',
  };
}

function questionEvent(requestId: string): AgentEvent {
  return {
    type: "question",
    mode: "cowork",
    sessionId: "s1",
    requestId,
    question: "Proceed?",
    options: [{ label: "Yes", value: "yes" }],
    multiSelect: false,
  };
}

const NO_STREAMING_TEXT_SCENARIO = (state: ModeState) =>
  turnEndForToolUse(turnStart(state));

// ── Reducer: permission anchoring ──────────────────────────────────────────

describe("permission_request anchoring (120s-timeout regression)", () => {
  it("anchors to the latest assistant message and stamping toolUseId when no text streamed", () => {
    // The exact production failure shape: streamingMessageId is null because
    // turn_end already fired; previously messageId became undefined and the
    // banner never rendered anywhere.
    let state = NO_STREAMING_TEXT_SCENARIO(emptyModeState());
    assert.equal(state.streamingMessageId, null);
    state = applyEventToMode(toolStart(state, "tu_1"), permissionRequest("p_1"));

    assert.equal(state.pendingPermissions.length, 1);
    assert.equal(state.pendingPermissions[0].messageId, "msg_assistant");
    assert.equal(state.pendingPermissions[0].toolUseId, "tu_1");
  });

  it("prefers the actively streaming message when text IS streaming", () => {
    let state = turnStart(emptyModeState());
    state = applyEventToMode(toolStart(state, "tu_2"), permissionRequest("p_2"));

    assert.equal(state.streamingMessageId, "msg_assistant");
    assert.equal(state.pendingPermissions[0].messageId, "msg_assistant");
    assert.equal(state.pendingPermissions[0].toolUseId, "tu_2");
  });

  it("still anchors by message (without toolUseId) when permission arrives after tool_end", () => {
    let state = NO_STREAMING_TEXT_SCENARIO(emptyModeState());
    state = applyEventToMode(state, {
      type: "tool_end",
      mode: "cowork",
      sessionId: "s1",
      toolUseId: "tu_3",
      result: { ok: true, content: "done" },
    });
    state = applyEventToMode(state, permissionRequest("p_3"));

    assert.equal(state.pendingPermissions[0].messageId, "msg_assistant");
    assert.equal(state.pendingPermissions[0].toolUseId, undefined);
  });
});

// ── Reducer: question anchoring + cleanup ──────────────────────────────────

describe("question anchoring and state cleanup", () => {
  it("stamps toolUseId from the asking tool (ask_user_question) even with no streamed text", () => {
    let state = NO_STREAMING_TEXT_SCENARIO(emptyModeState());
    state = applyEventToMode(toolStart(state, "tu_ask", "ask_user_question"), questionEvent("q_1"));

    assert.equal(state.pendingQuestions[0].messageId, "msg_assistant");
    assert.equal(state.pendingQuestions[0].toolUseId, "tu_ask");
  });

  it("clears lastToolUseId on terminal session_status along with pending arrays", () => {
    let state = NO_STREAMING_TEXT_SCENARIO(emptyModeState());
    state = applyEventToMode(toolStart(state, "tu_4"), permissionRequest("p_4"));
    state = applyEventToMode(state, {
      type: "session_status",
      mode: "cowork",
      sessionId: "s1",
      status: "idle",
    });

    assert.equal(state.lastToolUseId, null);
    assert.equal(state.pendingPermissions.length, 0);
  });

  it("clears lastToolUseId on error events", () => {
    let state = NO_STREAMING_TEXT_SCENARIO(emptyModeState());
    state = applyEventToMode(toolStart(state, "tu_5"), {
      type: "error",
      mode: "cowork",
      sessionId: "s1",
      message: "boom",
      recoverable: false,
    });

    assert.equal(state.lastToolUseId, null);
  });
});

// ── ChatView fallback helpers ──────────────────────────────────────────────

describe("anchorPendingItems / selectStranded (ChatView safety net)", () => {
  it("fills a missing messageId with the latest assistant id without touching existing anchors", () => {
    const items: Array<{ requestId: string; messageId?: string }> = [
      { requestId: "a", messageId: "kept" },
      { requestId: "b" },
    ];
    const anchored = anchorPendingItems(items, "latest");

    assert.equal(anchored[0].messageId, "kept");
    assert.equal(anchored[1].messageId, "latest");
    // Original list untouched.
    assert.equal(items[1].messageId, undefined);
  });

  it("leaves items as-is when there is no assistant message to anchor to", () => {
    const items: Array<{ requestId: string; messageId?: string }> = [{ requestId: "b" }];
    const anchored = anchorPendingItems(items, undefined);
    assert.equal(anchored[0].messageId, undefined);
  });

  it("selectStranded returns prompts whose anchor does not exist in the transcript", () => {
    const items = [
      { requestId: "valid", messageId: "m1" },
      { requestId: "stale", messageId: "deleted" },
      { requestId: "unanchored" },
    ];
    const stranded = selectStranded(items, new Set(["m1"]));

    assert.deepEqual(
      stranded.map((i) => i.requestId),
      ["stale", "unanchored"],
    );
  });

  it("collectStrandedPrompts partitions permissions and questions", () => {
    const result = collectStrandedPrompts(
      [
        { requestId: "p_ok", messageId: "m1", toolName: "x", input: {}, reason: "" },
        { requestId: "p_bad", messageId: "gone", toolName: "x", input: {}, reason: "" },
      ],
      [{ requestId: "q_bad", messageId: "gone", question: "", options: [], multiSelect: false }],
      new Set(["m1"]),
    );

    assert.deepEqual(result.permissions.map((p) => p.requestId), ["p_bad"]);
    assert.deepEqual(result.questions.map((q) => q.requestId), ["q_bad"]);
  });
});
