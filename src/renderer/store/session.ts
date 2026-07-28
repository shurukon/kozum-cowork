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
export type { ModeState, ToolCard, ToolStatus } from "./sessionTypes.ts";

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
}

// ── Helper: find which mode owns a sessionId ──────────────────────────────

function deriveModeFromSession(
  state: Pick<SessionStore, "cowork" | "code">,
  sessionId: string,
): Mode {
  if (state.cowork.messages.some((m) => m.id.startsWith(sessionId))) {
    return "cowork";
  }
  if (state.code.messages.some((m) => m.id.startsWith(sessionId))) {
    return "code";
  }
  if (state.cowork.streamingMessageId !== null) {
    return "cowork";
  }
  return "code";
}

// ── Store ─────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionStore>((set, get) => ({
  cowork: emptyModeState(),
  code: emptyModeState(),

  applyEvent(e: AgentEvent) {
    const state = get();
    let targetMode: Mode;

    const sid = e.sessionId;
    if (
      (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "turn_end") &&
      state.cowork.streamingMessageId === e.messageId
    ) {
      targetMode = "cowork";
    } else if (
      (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "turn_end") &&
      state.code.streamingMessageId === e.messageId
    ) {
      targetMode = "code";
    } else {
      targetMode = deriveModeFromSession(state, sid);
    }

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
}));
