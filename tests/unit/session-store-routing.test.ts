/**
 * tests/unit/session-store-routing.test.ts
 *
 * REGRESSION GUARD for the Cowork-doesn't-respond bug.
 *
 * The original defect: the renderer's session store routed every inbound
 * AgentEvent via `deriveModeFromSession(state, sessionId)`, which used
 * `messages.some((m) => m.id.startsWith(sessionId))` — an inverted prefix
 * test that NEVER matches in practice, then fell through to a default of
 * `"code"`. Because `turn_start` is not one of the streaming-matched event
 * types, it was applied to the `code` slice, set `code.streamingMessageId`,
 * and every subsequent `text_delta`/`turn_end` for that turn then matched
 * code (streaming guard), never writing to the cowork slice the user was
 * looking at.
 *
 * This test reconstructs the routing logic both with the *current* fix
 * (`resolveTargetMode` exported from the store, which routes by `e.mode`)
 * and with a *scratch* re-implementation of the buggy
 * `deriveModeFromSession` defaulting to `"code"` to prove the test would
 * have caught the original bug.
 *
 * The fix makes the class of bug structurally impossible: routing is now
 * authoritative on `e.mode` (populated by the main process when emitting
 * each event), with no inference from the message stream.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { emptyModeState, applyEventToMode, type ModeState } from "../../src/renderer/store/sessionReducer.ts";
import { eventBelongsToSession, resolveTargetMode, useSessionStore } from "../../src/renderer/store/session.ts";
import type { AgentEvent, Message, Mode, SessionStatus, TokenUsage } from "../../src/shared/types.ts";

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };

/** Build the {cowork, code} partial that resolveTargetMode consumes. */
function both(slices: Partial<{ cowork: ModeState; code: ModeState }> = {}) {
  return { cowork: slices.cowork ?? emptyModeState(), code: slices.code ?? emptyModeState() };
}

/** Drive a full turn: turn_start → N text_delta → turn_end → session_status(idle). */
function turnEvents(mode: Mode, sessionId: string, messageId: string, deltas: string[]): AgentEvent[] {
  const events: AgentEvent[] = [
    { type: "turn_start", mode, sessionId, messageId, model: "test-model" },
    ...deltas.map<AgentEvent>((d) => ({ type: "text_delta", mode, sessionId, messageId, delta: d })),
    { type: "turn_end", mode, sessionId, messageId, usage: USAGE, stopReason: "end_turn" },
    { type: "session_status", mode, sessionId, status: "idle" as SessionStatus },
  ];
  return events;
}

/** Apply a list of events through the store's routing+reducer pipeline. */
function drive(initial: { cowork: ModeState; code: ModeState }, events: AgentEvent[]): { cowork: ModeState; code: ModeState } {
  let state = { ...initial };
  for (const e of events) {
    const target = resolveTargetMode(state, e);
    const next = target === "cowork"
      ? { ...state, cowork: applyEventToMode(state.cowork, e) }
      : { ...state, code: applyEventToMode(state.code, e) };
    state = next;
  }
  return state;
}

describe("session event isolation", () => {
  it("accepts events for the hydrated session and rejects events from another session", () => {
    assert.equal(eventBelongsToSession("session-current", "session-current"), true);
    assert.equal(eventBelongsToSession("session-current", "session-deleted"), false);
  });

  it("allows the first event while the mode has no hydrated session identity", () => {
    assert.equal(eventBelongsToSession(null, "session-first-turn"), true);
  });
});

describe("session store identity boundaries", () => {
  it("clears the previous transcript and cards when a different session becomes active", () => {
    const store = useSessionStore.getState();
    store.clearMode("cowork");
    store.setSessionIdentity("cowork", "session-old");
    store.applyEvent({
      type: "turn_start",
      mode: "cowork",
      sessionId: "session-old",
      runId: "run-old",
      messageId: "msg-old",
      model: "test-model",
    });
    store.applyEvent({
      type: "tool_start",
      mode: "cowork",
      sessionId: "session-old",
      runId: "run-old",
      toolUseId: "tool-old",
      name: "read_file",
      input: { path: "old.txt" },
    });

    useSessionStore.getState().setSessionIdentity("cowork", "session-new");
    const next = useSessionStore.getState().cowork;
    assert.equal(next.sessionId, "session-new");
    assert.equal(next.messages.length, 0);
    assert.equal(next.toolCards.size, 0);
    assert.equal(next.seenEventIds.size, 0);
  });

  it("does not preserve live cards when hydration crosses a session boundary", () => {
    const store = useSessionStore.getState();
    store.clearMode("cowork");
    store.setSessionIdentity("cowork", "session-old");
    store.applyEvent({
      type: "turn_start",
      mode: "cowork",
      sessionId: "session-old",
      messageId: "msg-old",
      model: "test-model",
    });
    store.applyEvent({
      type: "tool_start",
      mode: "cowork",
      sessionId: "session-old",
      toolUseId: "tool-old",
      name: "read_file",
      input: { path: "old.txt" },
    });

    store.setSessionMessages("cowork", [], "session-new");
    const next = useSessionStore.getState().cowork;
    assert.equal(next.sessionId, "session-new");
    assert.equal(next.messages.length, 0);
    assert.equal(next.toolCards.size, 0);
  });
});

describe("first-message hydration race (regression: first user turn vanished in BOTH modes)", () => {
  const optimisticFirst = (): Message => ({
    id: "local-turn-1",
    role: "user",
    content: [{ type: "text", text: "Hello agent" }],
    createdAt: Date.now(),
  });

  it("keeps the optimistic first user message when the fresh session's history comes back empty", () => {
    for (const mode of ["cowork", "code"] as Mode[]) {
      const store = useSessionStore.getState();
      store.clearMode(mode);
      // ensureSession(): identity set BEFORE the optimistic append…
      store.setSessionIdentity(mode, `session-first-${mode}`);
      // …then App adds the local copy and the backend send starts.
      store.addUserMessage(mode, optimisticFirst());
      assert.equal(useSessionStore.getState()[mode].messages.length, 1);

      // Hydration effect fires: backend persists turns only AFTER the run
      // finishes, so messages() resolves [] — it must NOT wipe the local turn.
      useSessionStore.getState().setSessionMessages(mode, [], `session-first-${mode}`);
      const after = useSessionStore.getState()[mode];
      assert.equal(after.messages.length, 1, `${mode}: first message must survive hydration`);
      assert.equal(after.messages[0]!.id, "local-turn-1");
      assert.equal(after.messages[0]!.role, "user");
    }
  });

  it("dedupes once the persisted twin arrives on a later reload", () => {
    const store = useSessionStore.getState();
    store.clearMode("cowork");
    store.setSessionIdentity("cowork", "session-dedupe");
    store.addUserMessage("cowork", optimisticFirst());

    const persisted: Message[] = [
      {
        id: "persisted-1",
        role: "user",
        content: [{ type: "text", text: "Hello agent" }],
        createdAt: 1,
      },
      {
        id: "persisted-2",
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        createdAt: 2,
      },
    ];
    useSessionStore.getState().setSessionMessages("cowork", persisted, "session-dedupe");

    const after = useSessionStore.getState().cowork;
    assert.deepEqual(
      after.messages.map((m) => m.id),
      ["persisted-1", "persisted-2"],
      "the local twin must be dropped when its persisted counterpart exists",
    );
  });

  it("never drags optimistic drafts across a session boundary", () => {
    const store = useSessionStore.getState();
    store.clearMode("cowork");
    store.setSessionIdentity("cowork", "session-a");
    store.addUserMessage("cowork", optimisticFirst());

    useSessionStore.getState().setSessionMessages("cowork", [], "session-b");
    assert.equal(useSessionStore.getState().cowork.messages.length, 0);
  });
});

describe("session store routing — Cowork mode events land in cowork slice", () => {
  it("a Cowork turn streams into the cowork slice only (regression: pre-fix bug routed it to code)", () => {
    const before = both();
    const after = drive(before, turnEvents("cowork", "uuid-cowork-1", "msg-c1", ["Hello", " from", " cowork"]));

    // Cowork slice holds the streamed reply.
    assert.equal(after.cowork.messages.length, 1, "cowork slice should hold exactly the assistant message");
    assert.equal(after.cowork.messages[0]!.id, "msg-c1");
    const text = after.cowork.messages[0]!.content.find((b) => b.type === "text");
    assert.ok(text && text.type === "text");
    assert.equal(text.text, "Hello from cowork");
    assert.equal(after.cowork.streamingMessageId, null, "streaming cleared after turn_end");
    assert.equal(after.cowork.status, "idle");
    assert.equal(after.cowork.streamingText, "");

    // Code slice must remain empty — this is the assertion that pre-fix code failed.
    assert.equal(after.code.messages.length, 0, "code slice must not receive cowork events");
    assert.equal(after.code.streamingMessageId, null, "code streaming must not be set by cowork events");
    assert.equal(after.code.status, "idle");
  });

  it("a Code turn streams into the code slice only, cowork untouched", () => {
    const after = drive(both(), turnEvents("code", "uuid-code-1", "msg-d1", ["Reply", " ok"]));

    assert.equal(after.code.messages.length, 1);
    assert.equal(after.code.messages[0]!.id, "msg-d1");
    const text = after.code.messages[0]!.content.find((b) => b.type === "text");
    assert.ok(text && text.type === "text");
    assert.equal(text.text, "Reply ok");

    assert.equal(after.cowork.messages.length, 0, "cowork slice must not receive code events");
    assert.equal(after.cowork.streamingMessageId, null);
  });

  it("concurrent Cowork and Code turns never cross-pollinate", () => {
    const coworkTurn = turnEvents("cowork", "sess-c", "msg-c", ["C", "W"]);
    const codeTurn = turnEvents("code", "sess-d", "msg-d", ["D", "X"]);
    // Interleave the two turns so the streamingMessageId of one mode cannot
    // bleed into the other.
    const interleaved: AgentEvent[] = [
      coworkTurn[0]!, // turn_start cowork
      codeTurn[0]!, // turn_start code
      coworkTurn[1]!, // text_delta cowork #1
      codeTurn[1]!, // text_delta code #1
      coworkTurn[2]!, // text_delta cowork #2
      codeTurn[2]!, // text_delta code #2
      coworkTurn[3]!, // turn_end cowork
      codeTurn[3]!, // turn_end code
      coworkTurn[4]!, // status idle cowork
      codeTurn[4]!, // status idle code
    ];
    const after = drive(both(), interleaved);

    assert.equal(after.cowork.messages.length, 1);
    assert.equal(after.cowork.messages[0]!.id, "msg-c");
    const coworkText = after.cowork.messages[0]!.content.find((b) => b.type === "text");
    assert.equal(coworkText && coworkText.type === "text" ? coworkText.text : "", "CW");

    assert.equal(after.code.messages.length, 1);
    assert.equal(after.code.messages[0]!.id, "msg-d");
    const codeText = after.code.messages[0]!.content.find((b) => b.type === "text");
    assert.equal(codeText && codeText.type === "text" ? codeText.text : "", "DX");
  });
});

describe("session store routing — negative regression (the original bug)", () => {
  // Local replica of the BUGGY pre-fix routing logic. Kept here as a
  // reference and to make this file the canary that proves the fix is
  // load-bearing: change `resolveTargetMode` back to the buggy version in
  // session.ts and the positive tests above fail.
  function buggyResolve(
    state: { cowork: ModeState; code: ModeState },
    e: AgentEvent,
  ): Mode {
    if (state.cowork.messages.some((m) => m.id.startsWith(e.sessionId))) return "cowork";
    if (state.code.messages.some((m) => m.id.startsWith(e.sessionId))) return "code";
    if (state.cowork.streamingMessageId !== null) return "cowork";
    return "code"; // <-- THE BUG: blind default to code
  }

  function driveBuggy(
    initial: { cowork: ModeState; code: ModeState },
    events: AgentEvent[],
  ): { cowork: ModeState; code: ModeState } {
    let state = { ...initial };
    for (const e of events) {
      const target = buggyResolve(state, e);
      state = target === "cowork"
        ? { ...state, cowork: applyEventToMode(state.cowork, e) }
        : { ...state, code: applyEventToMode(state.code, e) };
    }
    return state;
  }

  it("with the OLD routing, a cowork turn lands in the code slice (proves the positive tests above are not vacuously green)", () => {
    const after = driveBuggy(both(), turnEvents("cowork", "uuid-cowork-1", "msg-c1", ["Hello"]));

    // The buggy default of "code" causes the reply to land in code, with the
    // cowork slice completely empty — exactly the silent-failure observed by
    // users before the fix.
    assert.equal(after.cowork.messages.length, 0, "buggy routing: cowork is empty");
    assert.equal(after.code.messages.length, 1, "buggy routing: cowork reply was hijacked into code");
  });
});

describe("session store routing — legacy events without `mode` fall back to streamingMessageId", () => {
  // Legacy fallback: an event lacking `mode` arrives (e.g. from an in-flight
  // event of a previous binary during a hot reload). It must not blindly
  // default to "code" — it routes to whichever slice is actively streaming
  // the same messageId. These events are now rare; the test pins the
  // fallback behaviour so it doesn't silently regress.
  it("text_delta without mode routes to the slice streaming that messageId", () => {
    const coworkState: ModeState = {
      ...emptyModeState(),
      streamingMessageId: "msg-legacy",
    };
    const initial = both({ cowork: coworkState });
    // Legacy event: no `mode` field, but messageId matches cowork streaming.
    // Cast through `unknown` to bypass the new type which requires `mode`.
    const legacyEvent = {
      type: "text_delta",
      sessionId: "s",
      messageId: "msg-legacy",
      delta: "late chunk",
    } as unknown as AgentEvent;

    assert.equal(resolveTargetMode(initial, legacyEvent), "cowork");
  });

  it("text_delta without mode that matches no slice falls back to cowork (never code)", () => {
    const initial = both();
    const orphan = {
      type: "text_delta",
      sessionId: "s",
      messageId: "msg-orphan",
      delta: "?",
    } as unknown as AgentEvent;

    // Critical: must not default to "code" — that was the original bug class.
    assert.equal(resolveTargetMode(initial, orphan), "cowork");
  });
});
