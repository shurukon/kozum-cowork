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
  dropMessagesFrom: (mode: Mode, messageId: string) => boolean;

  /** Reset the entire state for a mode (new session). */
  clearMode: (mode: Mode) => void;

  /** Set the session identity before asynchronous hydration or live events arrive. */
  setSessionIdentity: (mode: Mode, sessionId: string | null) => void;

  /** Set explicit session messages for a mode (loaded from backend). */
  setSessionMessages: (mode: Mode, messages: Message[], sessionId?: string | null) => void;

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
 * Return whether an inbound event belongs to the already hydrated session.
 * A null state is intentionally permissive for the first turn_start; the
 * caller will establish the identity from that event or from hydration.
 */
export function eventBelongsToSession(currentSessionId: string | null, eventSessionId: string): boolean {
  return currentSessionId === null || currentSessionId === eventSessionId;
}

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

/** Joined text of a message's text blocks — used for optimistic-dedupe. */
function messageText(message: Message): string {
  return message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  cowork: emptyModeState(),
  code: emptyModeState(),

  applyEvent(e: AgentEvent) {
    const state = get();
    const targetMode = resolveTargetMode(state, e);

    set((prev) => {
      const current = prev[targetMode];
      // IPC broadcasts events for all sessions on one channel. Once this mode
      // has an identity, reject every event from another session before the
      // reducer can mutate messages, cards, tasks, or prompts.
      if (!eventBelongsToSession(current.sessionId, e.sessionId)) return prev;
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

  /** T8: drop the message and everything after it (local transcript mirror of
   * the backend truncateFrom). Returns false when the anchor is gone. */
  dropMessagesFrom(mode: Mode, messageId: string): boolean {
    let removed = false;
    set((prev) => {
      const m = prev[mode];
      const idx = m.messages.findIndex((msg) => msg.id === messageId);
      if (idx === -1) return prev;
      removed = true;
      const kept = m.messages.slice(0, idx);
      const removedIds = new Set(m.messages.slice(idx).map((msg) => msg.id));
      const toolCards = new Map([...m.toolCards].filter(([id]) => !removedIds.has(id)));
      return { [mode]: { ...m, messages: kept, toolCards } };
    });
    return removed;
  },

  clearMode(mode: Mode) {
    set({ [mode]: emptyModeState() });
  },

  setSessionIdentity(mode: Mode, sessionId: string | null) {
    set((prev) => {
      if (prev[mode].sessionId === sessionId) return prev;
      const next = emptyModeState();
      next.sessionId = sessionId;
      return { [mode]: next };
    });
  },

  setSessionMessages(mode: Mode, messages: Message[], sessionId?: string | null) {
    set((prev) => {
      const sessionChanged =
        sessionId !== undefined && prev[mode].sessionId !== sessionId;

      // First-turn hydration race: the backend persists the user turn only
      // after the whole run finishes (manager.runLoop → appendMessages), so a
      // brand-new session's history fetch can come back EMPTY while the
      // optimistic `local-` copy of the first message is already on screen.
      // Replacing the slice wholesale used to erase it — the reported
      // "first user message never appears" bug in BOTH modes. Keep any
      // optimistic user turns that the persisted list does not reflect yet
      // (deduped by text so a later reload with the persisted twin shows one
      // copy), and prepend them because they are earlier turns.
      const persistedUserTexts = new Set(
        messages.filter((m) => m.role === "user").map(messageText),
      );
      const keptOptimistic = sessionChanged
        ? []
        : prev[mode].messages.filter(
            (m) =>
              m.role === "user" &&
              m.id.startsWith("local-") &&
              !persistedUserTexts.has(messageText(m)),
          );
      const mergedMessages =
        keptOptimistic.length > 0 ? [...keptOptimistic, ...messages] : messages;

      const reconstructed = reconstructToolCards(mergedMessages);
      const liveCards = sessionChanged ? new Map<string, ToolCard>() : prev[mode].toolCards;
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
          messages: mergedMessages,
          ...(sessionId !== undefined ? { sessionId } : {}),
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
          // Preserve live event ids while reloading the same session so a replay
          // cannot apply an event twice. A different identity is a hard boundary:
          // never let the previous session's dedupe set suppress or admit events.
          seenEventIds: sessionChanged ? new Set<string>() : prev[mode].seenEventIds,
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
