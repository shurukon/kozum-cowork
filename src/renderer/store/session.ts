/**
 * Kozum Cowork — session store.
 *
 * Keeps per-mode state fully independent: switching modes is a view change,
 * not a teardown. Each mode holds its own message list, streaming state, and
 * task list. A single `applyEvent` reducer handles every AgentEvent variant
 * so there is exactly one place the event→state mapping lives.
 */

import { create } from "zustand";
import type { Mode, Message, AgentEvent } from "@shared/types.ts";
import type { ModeState } from "./sessionTypes.ts";
import { applyEventToMode, emptyModeState } from "./sessionReducer.ts";

// Re-export for consumers who import from session.ts.
export type { ModeState, ToolCard, ToolStatus, PendingQuestion, PendingPermission } from "./sessionTypes.ts";

// ── Store shape ───────────────────────────────────────────────────────────

export interface SessionStore {
  cowork: ModeState;
  code: ModeState;

  /** Apply an inbound AgentEvent to the appropriate mode's state. */
  applyEvent: (e: AgentEvent) => void;

  /** Append a user message immediately (optimistic). */
  addUserMessage: (mode: Mode, message: Message) => void;

  /** Reset the entire state for a mode (new session). */
  clearMode: (mode: Mode) => void;

  /** Set explicit session messages for a mode (loaded from backend). */
  setSessionMessages: (mode: Mode, messages: Message[]) => void;

  /** Remove an answered question prompt from the given mode. */
  resolveQuestion: (mode: Mode, requestId: string) => void;

  /** Remove a resolved permission prompt from the given mode. */
  resolvePermission: (mode: Mode, requestId: string) => void;
}

// ── Helper: resolve which mode slice an inbound event belongs to ───────────
//
// Authoritative source is `e.mode`, which the main process now attaches to
// every AgentEvent. The previous inference (matching message ids against the
// session id) was structurally wrong: a session id never prefixes a message
// id, so every non-streaming-matched event (notably `turn_start`) fell through
// to the `"code"` default — which meant Cowork's `turn_start` set
// `code.streamingMessageId`, and the entire reply stream then matched code and
// was written there, leaving the Cowork tab empty.
//
// The streaming-message-id fallback below only applies to legacy events that
// somehow arrive without `mode` (e.g. an in-flight event from a previous
// binary during a hot reload). It must never default to `"code"` blindly; it
// instead matches whichever slice is actively streaming that messageId, and
// only falls back to `"cowork"` as a last resort (the app's default view).
//
// NOTE: the per-message `streamingMessageId === e.messageId` guards inside the
// reducer are correct and stay — they prevent a stale event from an aborted
// turn overwriting the current one on the same slice. Routing only selects
// which slice; those guards operate after routing, within the slice.

/** Exported for unit testing only — see tests/unit/session-store-routing.test.ts. */
export function resolveTargetMode(
  state: Pick<SessionStore, "cowork" | "code">,
  e: AgentEvent,
): Mode {
  // Authoritative: every event emitted by the current backend carries `mode`.
  if (e.mode === "cowork" || e.mode === "code") return e.mode;

  // Legacy fallback for events lacking `mode` (pre-upgrade binary mid-flight).
  // Only the streaming-matched variants carry a messageId; match it to the
  // slice actively streaming that turn.
  if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "turn_end") {
    if (state.cowork.streamingMessageId === e.messageId) return "cowork";
    if (state.code.streamingMessageId === e.messageId) return "code";
  }
  // No information available — default to the app's default view, never code.
  return "cowork";
}

// ── Store ─────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionStore>((set, get) => ({
  cowork: emptyModeState(),
  code: emptyModeState(),

  applyEvent(e: AgentEvent) {
    const state = get();
    const targetMode = resolveTargetMode(state, e);

    set((prev) => {
      if (targetMode === "cowork") {
        return { cowork: applyEventToMode(prev.cowork, e) };
      }
      return { code: applyEventToMode(prev.code, e) };
    });
  },

  addUserMessage(mode: Mode, message: Message) {
    set((prev) => {
      const m = prev[mode];
      return { [mode]: { ...m, messages: [...m.messages, message] } };
    });
  },

  clearMode(mode: Mode) {
    set({ [mode]: emptyModeState() });
  },

  setSessionMessages(mode: Mode, messages: Message[]) {
    set((prev) => ({
      [mode]: {
        ...prev[mode],
        messages,
        streamingMessageId: null,
        streamingText: "",
        streamingThinking: "",
        toolCards: new Map(),
        error: null,
        // Pending question/permission arrays are UI-only state; once messages
        // are replaced from the backend there is nothing live to answer, so
        // drop them to avoid a stale dangling form.
        pendingQuestions: [],
        pendingPermissions: [],
      },
    }));
  },

  resolveQuestion(mode: Mode, requestId: string) {
    set((prev) => {
      const m = prev[mode];
      if (!m.pendingQuestions.some((q) => q.requestId === requestId)) return prev;
      return {
        [mode]: {
          ...m,
          pendingQuestions: m.pendingQuestions.filter(
            (q) => q.requestId !== requestId,
          ),
        },
      };
    });
  },

  resolvePermission(mode: Mode, requestId: string) {
    set((prev) => {
      const m = prev[mode];
      if (!m.pendingPermissions.some((p) => p.requestId === requestId)) return prev;
      return {
        [mode]: {
          ...m,
          pendingPermissions: m.pendingPermissions.filter(
            (p) => p.requestId !== requestId,
          ),
        },
      };
    });
  },
}));
