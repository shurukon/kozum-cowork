/**
 * Kozum Cowork — session store.
 *
 * Keeps per-mode state fully independent: switching modes is a view change,
 * not a teardown. Each mode holds its own message list, streaming state, and
 * task list. A single `applyEvent` reducer handles every AgentEvent variant
 * so there is exactly one place the event→state mapping lives.
 */

import { create } from "zustand";
import type {
  Mode,
  Message,
  AgentEvent,
  ToolResult,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  TextBlock,
  ImageBlock,
} from "@shared/types.ts";
import type { ModeState, ToolCard } from "./sessionTypes.ts";
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

/**
 * Rebuild a `toolCards` map from persisted messages.
 *
 * BUG-3 fix: when a session is reloaded from disk the renderer previously
 * dropped every ToolCard by resetting the map to `new Map()`. That wiped the
 * whole tool-call transcript on reload — cards only existed in live event
 * state. This pure helper walks the persisted `Message[]` and reconstructs a
 * card per `tool_use` block (status "running") then patches in the matching
 * `tool_result` (status "ok"|"error") from the next user message.
 *
 * The reconstructed `ToolResult` is intentionally minimal — it only carries
 * what the transcript card UI needs (ok flag, text content, any images). The
 * full `display` payload is not persisted, so we don't try to fake one.
 */
export function reconstructToolCards(messages: Message[]): Map<string, ToolCard> {
  const cards = new Map<string, ToolCard>();

  // First pass: create a card per tool_use block in assistant messages.
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== "tool_use") continue;
      const tu = block as ToolUseBlock;
      cards.set(tu.id, {
        toolUseId: tu.id,
        name: tu.name,
        input: tu.input,
        status: "running",
        notes: [],
        result: null,
        autoCollapse: true,
      });
    }
  }

  // Second pass: match tool_result blocks in user messages to cards.
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== "tool_result") continue;
      const tr = block as ToolResultBlock;
      const card = cards.get(tr.toolUseId);
      if (!card) continue;

      const textParts: string[] = [];
      const images: Array<{ mimeType: string; data: string }> = [];
      for (const part of tr.content) {
        if (part.type === "text") {
          textParts.push((part as TextBlock).text);
        } else if (part.type === "image") {
          const im = part as ImageBlock;
          images.push({ mimeType: im.mimeType, data: im.data });
        }
      }

      const result: ToolResult = {
        ok: !tr.isError,
        content: textParts.join("\n"),
      };
      if (images.length > 0) result.images = images;

      card.status = tr.isError ? "error" : "ok";
      card.result = result;
    }
  }

  return cards;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  cowork: emptyModeState(),
  code: emptyModeState(),

  applyEvent(e: AgentEvent) {
    const state = get();
    const targetMode = resolveTargetMode(state, e);

    set((prev) => {
      const current = prev[targetMode];
      const seenEventIds = new Set(current.seenEventIds);
      if (e.eventId && seenEventIds.has(e.eventId)) return prev;
      if (e.eventId) seenEventIds.add(e.eventId);
      const next = applyEventToMode(current, e);
      return { [targetMode]: { ...next, seenEventIds } };
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
    set((prev) => {
      const reconstructed = reconstructToolCards(messages);
      const liveCards = prev[mode].toolCards;
      // Backend transcript hydration does not persist the rich `display`
      // payload. Preserve it from the live event card when the same tool call
      // is already known, while still taking the persisted final status.
      for (const [toolUseId, persisted] of reconstructed) {
        const live = liveCards.get(toolUseId);
        if (!live) continue;
        reconstructed.set(toolUseId, {
          ...persisted,
          ...live,
          status: persisted.status,
          result: live.result ?? persisted.result,
        });
      }
      return {
        [mode]: {
          ...prev[mode],
          messages,
          streamingMessageId: null,
          streamingText: "",
          streamingThinking: "",
          toolCards: reconstructed,
          error: null,
          // Pending question/permission arrays are UI-only state; once messages
          // are replaced from the backend there is nothing live to answer, so
          // drop them to avoid a stale dangling form.
          pendingQuestions: [],
          pendingPermissions: [],
          // Preserve live event ids while the transcript is being reloaded. A
          // replay can arrive after the live subscription during startup; clearing
          // this set here would apply those events a second time. clearMode() is
          // the explicit boundary that resets it for a genuinely new session.
          seenEventIds: prev[mode].seenEventIds,
        },
      };
    });
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
